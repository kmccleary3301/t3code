import ExpoModulesCore
import Foundation
import Network
import ssh2

private struct SshFailure: LocalizedError {
  let code: String
  let message: String

  var description: String { "\(code):\(message)" }
  var errorDescription: String? { description }
}

private struct ResolvedAddress {
  let family: Int32
  let socktype: Int32
  let proto: Int32
  let address: Data
}

private final class ResolutionBox {
  private let lock = NSLock()
  private var result: [ResolvedAddress]?

  func set(_ result: [ResolvedAddress]) {
    lock.lock()
    self.result = result
    lock.unlock()
  }

  func take() -> [ResolvedAddress]? {
    lock.lock()
    defer { lock.unlock() }
    return result
  }
}

private final class ContinuationGate<Value> {
  private let lock = NSLock()
  private var resumed = false
  private let continuation: CheckedContinuation<Value, Error>

  init(_ continuation: CheckedContinuation<Value, Error>) {
    self.continuation = continuation
  }

  @discardableResult
  func succeed(_ value: Value) -> Bool {
    lock.lock()
    guard !resumed else {
      lock.unlock()
      return false
    }
    resumed = true
    lock.unlock()
    continuation.resume(returning: value)
    return true
  }

  @discardableResult
  func fail(_ error: Error) -> Bool {
    lock.lock()
    guard !resumed else {
      lock.unlock()
      return false
    }
    resumed = true
    lock.unlock()
    continuation.resume(throwing: error)
    return true
  }
}

private final class IosSshChannel {
  var pointer: OpaquePointer?

  init(_ pointer: OpaquePointer) {
    self.pointer = pointer
  }
}

private final class IosSshClient {
  let queue = DispatchQueue(label: "com.t3tools.kmcode.ssh", qos: .userInitiated)
  var session: OpaquePointer?
  var socket: Int32 = -1
  var listeners: [ObjectIdentifier: NWListener] = [:]
  var pendingForwards: [ObjectIdentifier: ContinuationGate<[String: Int]>] = [:]
  var channels: [ObjectIdentifier: IosSshChannel] = [:]
  var pipes: [ObjectIdentifier: ForwardPipe] = [:]
  var didClose = false
  var teardownFailures: [SshFailure] = []

  private let stateLock = NSLock()
  private var stopping = false
  private var wakeReadFD: Int32
  private var wakeWriteFD: Int32

  init() {
    var descriptors: [Int32] = [-1, -1]
    let result = descriptors.withUnsafeMutableBufferPointer { buffer -> Int32 in
      guard let baseAddress = buffer.baseAddress else { return -1 }
      return Darwin.pipe(baseAddress)
    }
    guard result == 0 else {
      wakeReadFD = -1
      wakeWriteFD = -1
      return
    }
    wakeReadFD = descriptors[0]
    wakeWriteFD = descriptors[1]
    guard setNonBlocking(wakeReadFD), setNonBlocking(wakeWriteFD) else {
      Darwin.close(wakeReadFD)
      Darwin.close(wakeWriteFD)
      wakeReadFD = -1
      wakeWriteFD = -1
      return
    }
  }

  func isStopping() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return stopping
  }

  func requestStop() {
    stateLock.lock()
    if !stopping {
      stopping = true
      if wakeWriteFD >= 0 {
        var byte: UInt8 = 1
        let result = Darwin.write(wakeWriteFD, &byte, 1)
        if result < 0 && errno != EAGAIN {
          Darwin.close(wakeWriteFD)
          wakeWriteFD = -1
        }
      }
    }
    stateLock.unlock()
  }

  func wakeDescriptor() -> Int32 {
    stateLock.lock()
    defer { stateLock.unlock() }
    return wakeReadFD
  }

  func consumeWake() {
    stateLock.lock()
    let descriptor = wakeReadFD
    stateLock.unlock()
    guard descriptor >= 0 else { return }
    var byte: UInt8 = 0
    while true {
      let result = Darwin.read(descriptor, &byte, 1)
      if result > 0 { continue }
      if result < 0 && errno == EINTR { continue }
      break
    }
  }

  func closeWakeDescriptors() {
    stateLock.lock()
    let readDescriptor = wakeReadFD
    let writeDescriptor = wakeWriteFD
    wakeReadFD = -1
    wakeWriteFD = -1
    if readDescriptor >= 0 { Darwin.close(readDescriptor) }
    if writeDescriptor >= 0 { Darwin.close(writeDescriptor) }
    stateLock.unlock()
  }

  func recordTeardownFailure(_ failure: SshFailure) {
    teardownFailures.append(failure)
  }

  @discardableResult
  private func setNonBlocking(_ descriptor: Int32) -> Bool {
    guard descriptor >= 0 else { return false }
    let flags = fcntl(descriptor, F_GETFL, 0)
    guard flags >= 0 else { return false }
    return fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0
  }
}

private final class ForwardPipe {
  let connection: NWConnection
  var channel: IosSshChannel?
  var started = false
  var closed = false
  var localEOF = false
  var remoteEOF = false
  var localReceivePending = false
  var remoteSendPending = false

  init(connection: NWConnection) {
    self.connection = connection
  }
}

private final class IosSshStore {
  static let shared = IosSshStore()
  private static let libraryInitStatus = libssh2_init(0)

  private static let connectTimeout: UInt64 = 30_000_000_000
  private static let execTimeout: UInt64 = 120_000_000_000
  private static let listenerTimeout: UInt64 = 15_000_000_000

  private let lock = NSLock()
  private var clients: [String: IosSshClient] = [:]

  private func client(_ id: String) throws -> IosSshClient {
    lock.lock()
    defer { lock.unlock() }
    guard let client = clients[id] else {
      throw SshFailure(code: "T3_SSH_SESSION_NOT_FOUND", message: id)
    }
    return client
  }

  private func removeClient(_ id: String) -> IosSshClient? {
    lock.lock()
    defer { lock.unlock() }
    return clients.removeValue(forKey: id)
  }

  private func ensureLibrary() throws {
    guard Self.libraryInitStatus == 0 else {
      throw SshFailure(code: "T3_SSH_LIBRARY", message: "libssh2 could not initialize.")
    }
  }

  func inspect(host: String, port: Int) async throws -> [String: String] {
    try ensureLibrary()
    let port = try validatePort(port, code: "T3_SSH_CONNECT")
    guard !host.isEmpty else {
      throw SshFailure(code: "T3_SSH_CONNECT", message: "A host is required.")
    }

    let client = IosSshClient()
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: String], Error>) in
      client.queue.async {
        let deadline = self.deadline(after: Self.connectTimeout)
        do {
          try self.open(client: client, host: host, port: port, deadline: deadline)
          guard let fingerprint = self.fingerprint(client.session) else {
            throw SshFailure(code: "T3_SSH_FINGERPRINT", message: "Server did not provide a host key.")
          }
          continuation.resume(returning: ["fingerprint": fingerprint])
        } catch {
          continuation.resume(throwing: error)
        }
        self.close(client)
      }
    }
  }

  func connect(host: String, port: Int, username: String, password: String?, privateKey: String?, passphrase: String?, expected: String?) async throws -> [String: String] {
    try ensureLibrary()
    let port = try validatePort(port, code: "T3_SSH_CONNECT")
    guard !host.isEmpty else {
      throw SshFailure(code: "T3_SSH_CONNECT", message: "A host is required.")
    }
    guard password?.isEmpty == false || privateKey?.isEmpty == false else {
      throw SshFailure(code: "T3_SSH_AUTH_REQUIRED", message: "A password or private key is required.")
    }

    let client = IosSshClient()
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: String], Error>) in
      client.queue.async {
        let deadline = self.deadline(after: Self.connectTimeout)
        do {
          try self.open(client: client, host: host, port: port, deadline: deadline)
          guard let actual = self.fingerprint(client.session) else {
            throw SshFailure(code: "T3_SSH_FINGERPRINT", message: "Server did not provide a host key.")
          }
          guard let expected, !expected.isEmpty else {
            throw SshFailure(code: "T3_SSH_HOST_KEY_REQUIRED", message: actual)
          }
          guard expected == actual else {
            throw SshFailure(code: "T3_SSH_HOST_KEY_MISMATCH", message: "Expected \(expected), received \(actual).")
          }
          try self.authenticate(client: client, username: username, password: password, privateKey: privateKey, passphrase: passphrase, deadline: deadline)
          let id = UUID().uuidString
          self.lock.lock()
          self.clients[id] = client
          self.lock.unlock()
          continuation.resume(returning: ["sessionId": id, "fingerprint": actual])
        } catch {
          self.close(client)
          continuation.resume(throwing: error)
        }
      }
    }
  }

  func exec(id: String, command: String, stdin: String?) async throws -> [String: Any] {
    let client = try client(id)
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Any], Error>) in
      client.queue.async {
        do {
          let deadline = self.deadline(after: Self.execTimeout)
          try self.ensureActive(client, deadline: deadline)
          guard let session = client.session else {
            throw SshFailure(code: "T3_SSH_SESSION", message: "SSH session is unavailable.")
          }

          let channel = try self.openSessionChannel(client: client, session: session, deadline: deadline)
          let channelID = ObjectIdentifier(channel)
          client.channels[channelID] = channel
          defer {
            client.channels.removeValue(forKey: channelID)
            self.closeChannel(client: client, channel: channel)
          }

          try command.withCString { commandPointer in
            try self.retryStatus(client: client, session: session, deadline: deadline, code: "T3_SSH_EXEC", message: "Remote command could not start.") {
              libssh2_channel_process_startup(channel.pointer!, "exec", 4, commandPointer, UInt32(command.utf8.count))
            }
          }
          if let stdin {
            try self.write(client: client, session: session, channel: channel, data: Data(stdin.utf8), deadline: deadline)
          }
          try self.sendEOF(client: client, session: session, channel: channel, deadline: deadline)

          var stdout = Data()
          var stderr = Data()
          try self.drain(client: client, session: session, channel: channel, stdout: &stdout, stderr: &stderr, deadline: deadline)
          try self.retryStatus(client: client, session: session, deadline: deadline, code: "T3_SSH_EXEC", message: "Remote command did not close.") {
            libssh2_channel_wait_closed(channel.pointer!)
          }
          let exitCode = libssh2_channel_get_exit_status(channel.pointer!)
          continuation.resume(returning: [
            "stdout": String(decoding: stdout, as: UTF8.self),
            "stderr": String(decoding: stderr, as: UTF8.self),
            "exitCode": exitCode
          ])
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  func forward(id: String, remoteHost: String, remotePort: Int) async throws -> [String: Int] {
    let client = try client(id)
    let remotePort = try validatePort(remotePort, code: "T3_SSH_FORWARD")
    guard !remoteHost.isEmpty else {
      throw SshFailure(code: "T3_SSH_FORWARD", message: "A remote host is required.")
    }

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: Int], Error>) in
      client.queue.async {
        let gate = ContinuationGate(continuation)
        do {
          try self.ensureActive(client, deadline: self.deadline(after: Self.connectTimeout))
          let parameters = NWParameters.tcp
          parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: .any)
          let listener = try NWListener(using: parameters)
          let listenerID = ObjectIdentifier(listener)
          client.listeners[listenerID] = listener
          client.pendingForwards[listenerID] = gate

          listener.newConnectionHandler = { [weak self, weak client] connection in
            guard let self, let client else {
              connection.cancel()
              return
            }
            let pipe = ForwardPipe(connection: connection)
            client.queue.async {
              guard !client.isStopping() else {
                connection.cancel()
                return
              }
              client.pipes[ObjectIdentifier(pipe)] = pipe
              self.startForwardPipe(pipe, client: client, remoteHost: remoteHost, remotePort: remotePort)
            }
          }
          listener.stateUpdateHandler = { [weak self, weak client, weak listener] state in
            guard let self, let client else { return }
            client.queue.async {
              guard let listener else { return }
              switch state {
              case .ready:
                guard let port = listener.port?.rawValue else {
                  client.pendingForwards.removeValue(forKey: listenerID)
                  _ = gate.fail(SshFailure(code: "T3_SSH_FORWARD", message: "Forward listener did not publish a local port."))
                  self.removeListener(listener, client: client)
                  return
                }
                if gate.succeed(["localPort": Int(port)]) {
                  client.pendingForwards.removeValue(forKey: listenerID)
                }
              case .failed(let error):
                client.pendingForwards.removeValue(forKey: listenerID)
                self.removeListener(listener, client: client)
                _ = gate.fail(SshFailure(code: "T3_SSH_FORWARD", message: "Local listener failed: \(String(describing: error))."))
              case .cancelled:
                client.pendingForwards.removeValue(forKey: listenerID)
                self.removeListener(listener, client: client)
                _ = gate.fail(SshFailure(code: "T3_SSH_FORWARD", message: "Local listener was cancelled."))
              default:
                break
              }
            }
          }
          listener.start(queue: client.queue)
          DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .nanoseconds(Int(Self.listenerTimeout))) {
            if gate.fail(SshFailure(code: "T3_SSH_TIMEOUT", message: "Local forward listener did not become ready.")) {
              client.queue.async {
                client.pendingForwards.removeValue(forKey: listenerID)
                self.removeListener(listener, client: client)
              }
            }
          }
        } catch {
          _ = gate.fail(error)
        }
      }
    }
  }

  func disconnect(id: String) async throws {
    guard let client = removeClient(id) else { return }
    client.requestStop()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      client.queue.async {
        self.close(client)
        if let failure = client.teardownFailures.first {
          continuation.resume(throwing: failure)
        } else {
          continuation.resume(returning: ())
        }
      }
    }
  }

  func disconnectAll() {
    lock.lock()
    let retained = Array(clients.values)
    clients.removeAll()
    lock.unlock()
    for client in retained {
      client.requestStop()
      client.queue.async { self.close(client) }
    }
  }

  private func deadline(after nanoseconds: UInt64) -> DispatchTime {
    .now() + .nanoseconds(Int(nanoseconds))
  }

  private func remainingNanoseconds(until deadline: DispatchTime) -> UInt64 {
    let now = DispatchTime.now().uptimeNanoseconds
    return deadline.uptimeNanoseconds > now ? deadline.uptimeNanoseconds - now : 0
  }

  private func validatePort(_ port: Int, code: String) throws -> Int32 {
    guard (1...65_535).contains(port) else {
      throw SshFailure(code: code, message: "Port must be between 1 and 65535.")
    }
    return Int32(port)
  }


  private func ensureActive(_ client: IosSshClient, deadline: DispatchTime) throws {
    if client.isStopping() {
      throw SshFailure(code: "T3_SSH_DISCONNECTED", message: "SSH session was disconnected.")
    }
    if remainingNanoseconds(until: deadline) == 0 {
      throw SshFailure(code: "T3_SSH_TIMEOUT", message: "SSH operation timed out.")
    }
  }

  private func resolve(host: String, port: Int32, client: IosSshClient, deadline: DispatchTime) throws -> [ResolvedAddress] {
    try ensureActive(client, deadline: deadline)
    let box = ResolutionBox()
    let signal = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
      var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM, ai_protocol: IPPROTO_TCP, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
      var result: UnsafeMutablePointer<addrinfo>?
      let status = getaddrinfo(host, String(port), &hints, &result)
      var addresses: [ResolvedAddress] = []
      if status == 0 {
        var cursor = result
        while let info = cursor {
          if let address = info.pointee.ai_addr {
            addresses.append(ResolvedAddress(
              family: info.pointee.ai_family,
              socktype: info.pointee.ai_socktype,
              proto: info.pointee.ai_protocol,
              address: Data(bytes: address, count: Int(info.pointee.ai_addrlen))
            ))
          }
          cursor = info.pointee.ai_next
        }
      }
      if let result { freeaddrinfo(result) }
      box.set(addresses)
      signal.signal()
    }

    let nanoseconds = remainingNanoseconds(until: deadline)
    let waitResult = signal.wait(timeout: .now() + .nanoseconds(Int(min(nanoseconds, UInt64(Int.max)))))
    guard waitResult == .success else {
      throw SshFailure(code: "T3_SSH_TIMEOUT", message: "DNS lookup timed out.")
    }
    try ensureActive(client, deadline: deadline)
    guard let addresses = box.take(), !addresses.isEmpty else {
      throw SshFailure(code: "T3_SSH_CONNECT", message: "Could not resolve \(host).")
    }
    return addresses
  }

  private func open(client: IosSshClient, host: String, port: Int32, deadline: DispatchTime) throws {
    let addresses = try resolve(host: host, port: port, client: client, deadline: deadline)
    var lastFailure: Error?

    for address in addresses {
      try ensureActive(client, deadline: deadline)
      let descriptor = Darwin.socket(address.family, address.socktype, address.proto)
      guard descriptor >= 0 else { continue }
      let flags = fcntl(descriptor, F_GETFL, 0)
      guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
        Darwin.close(descriptor)
        continue
      }
      var noSigPipe: Int32 = 1
      guard setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
        Darwin.close(descriptor)
        continue
      }

      let result = address.address.withUnsafeBytes { rawAddress -> Int32 in
        guard let baseAddress = rawAddress.baseAddress else { return -1 }
        return Darwin.connect(descriptor, baseAddress.assumingMemoryBound(to: sockaddr.self), socklen_t(rawAddress.count))
      }
      if result != 0 && errno != EINPROGRESS {
        Darwin.close(descriptor)
        continue
      }
      if result != 0 {
        do {
          try waitForIO(client: client, session: nil, deadline: deadline, socket: descriptor, events: Int16(POLLOUT))
          var socketError: Int32 = 0
          var socketErrorLength = socklen_t(MemoryLayout<Int32>.size)
          guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorLength) == 0, socketError == 0 else {
            Darwin.close(descriptor)
            continue
          }
        } catch {
          Darwin.close(descriptor)
          throw error
        }
      }

      client.socket = descriptor
      guard let session = libssh2_session_init_ex(nil, nil, nil, nil) else {
        Darwin.close(descriptor)
        client.socket = -1
        continue
      }
      client.session = session
      libssh2_session_set_blocking(session, 0)
      do {
        try retryStatus(client: client, session: session, deadline: deadline, code: "T3_SSH_CONNECT", message: "SSH handshake failed.") {
          libssh2_session_handshake(session, descriptor)
        }
        return
      } catch {
        lastFailure = error
        abandonSession(client)
        if let failure = error as? SshFailure, failure.code == "T3_SSH_TIMEOUT" || failure.code == "T3_SSH_DISCONNECTED" {
          throw error
        }
      }
    }

    if let lastFailure { throw lastFailure }
    throw SshFailure(code: "T3_SSH_CONNECT", message: "Could not connect to \(host):\(port).")
  }

  private func fingerprint(_ session: OpaquePointer?) -> String? {
    guard let session, let hash = libssh2_hostkey_hash(session, LIBSSH2_HOSTKEY_HASH_SHA256) else { return nil }
    return "SHA256:" + Data(bytes: hash, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: "")
  }

  private func authenticate(client: IosSshClient, username: String, password: String?, privateKey: String?, passphrase: String?, deadline: DispatchTime) throws {
    guard let session = client.session else {
      throw SshFailure(code: "T3_SSH_AUTH", message: "SSH session is unavailable.")
    }
    try retryStatus(client: client, session: session, deadline: deadline, code: "T3_SSH_AUTH", message: "SSH authentication failed.") {
      username.withCString { user in
        if let password, !password.isEmpty {
          return password.withCString { pass in
            libssh2_userauth_password_ex(session, user, UInt32(username.utf8.count), pass, UInt32(password.utf8.count), nil)
          }
        }
        guard let privateKey, !privateKey.isEmpty else { return -1 }
        return privateKey.withCString { key in
          if let passphrase {
            return passphrase.withCString { pass in
              libssh2_userauth_publickey_frommemory(session, user, username.utf8.count, nil, 0, key, privateKey.utf8.count, pass)
            }
          }
          return libssh2_userauth_publickey_frommemory(session, user, username.utf8.count, nil, 0, key, privateKey.utf8.count, nil)
        }
      }
    }
  }

  private func retryStatus(client: IosSshClient, session: OpaquePointer, deadline: DispatchTime, code: String, message: String, operation: () -> Int32) throws {
    while true {
      try ensureActive(client, deadline: deadline)
      let status = operation()
      if status == 0 { return }
      if status != Int32(LIBSSH2_ERROR_EAGAIN) {
        throw SshFailure(code: code, message: message)
      }
      try waitForIO(client: client, session: session, deadline: deadline)
    }
  }

  private func openSessionChannel(client: IosSshClient, session: OpaquePointer, deadline: DispatchTime) throws -> IosSshChannel {
    while true {
      try ensureActive(client, deadline: deadline)
      if let pointer = libssh2_channel_open_ex(session, "session", 7, 2 * 1024 * 1024, UInt32(LIBSSH2_CHANNEL_PACKET_DEFAULT), nil, 0) {
        libssh2_channel_set_blocking(pointer, 0)
        return IosSshChannel(pointer)
      }
      let status = libssh2_session_last_errno(session)
      guard status == Int32(LIBSSH2_ERROR_EAGAIN) else {
        throw SshFailure(code: "T3_SSH_CHANNEL", message: "Could not open SSH channel.")
      }
      try waitForIO(client: client, session: session, deadline: deadline)
    }
  }

  private func openDirectChannel(client: IosSshClient, session: OpaquePointer, remoteHost: String, remotePort: Int32, deadline: DispatchTime) throws -> IosSshChannel {
    while true {
      try ensureActive(client, deadline: deadline)
      let pointer = remoteHost.withCString { host in
        libssh2_channel_direct_tcpip_ex(session, host, remotePort, "127.0.0.1", 0)
      }
      if let pointer {
        libssh2_channel_set_blocking(pointer, 0)
        return IosSshChannel(pointer)
      }
      let status = libssh2_session_last_errno(session)
      guard status == Int32(LIBSSH2_ERROR_EAGAIN) else {
        throw SshFailure(code: "T3_SSH_FORWARD", message: "Could not open remote forwarding channel.")
      }
      try waitForIO(client: client, session: session, deadline: deadline)
    }
  }

  private func write(client: IosSshClient, session: OpaquePointer, channel: IosSshChannel, data: Data, deadline: DispatchTime) throws {
    guard let pointer = channel.pointer else {
      throw SshFailure(code: "T3_SSH_WRITE", message: "SSH channel is closed.")
    }
    var offset = 0
    while offset < data.count {
      try ensureActive(client, deadline: deadline)
      let remaining = data.count - offset
      let count = data.withUnsafeBytes { rawBuffer -> Int in
        guard let baseAddress = rawBuffer.baseAddress else { return 0 }
        let address = baseAddress.advanced(by: offset).assumingMemoryBound(to: CChar.self)
        return Int(libssh2_channel_write_ex(pointer, 0, address, remaining))
      }
      if count > 0 {
        offset += count
        continue
      }
      if count == 0 || count == Int(LIBSSH2_ERROR_EAGAIN) {
        try waitForIO(client: client, session: session, deadline: deadline)
        continue
      }
      throw SshFailure(code: "T3_SSH_WRITE", message: "Remote write failed.")
    }
  }

  private func sendEOF(client: IosSshClient, session: OpaquePointer, channel: IosSshChannel, deadline: DispatchTime) throws {
    guard let pointer = channel.pointer else {
      throw SshFailure(code: "T3_SSH_WRITE", message: "SSH channel is closed.")
    }
    try retryStatus(client: client, session: session, deadline: deadline, code: "T3_SSH_WRITE", message: "Could not send stdin EOF.") {
      libssh2_channel_send_eof(pointer)
    }
  }

  private func readChunk(channel: IosSshChannel, stream: Int32) throws -> (count: Int, data: Data) {
    guard let pointer = channel.pointer else {
      throw SshFailure(code: "T3_SSH_READ", message: "SSH channel is closed.")
    }
    let capacity = 8192
    var buffer = Data(repeating: 0, count: capacity)
    let count = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
      guard let baseAddress = rawBuffer.baseAddress else { return 0 }
      let address = baseAddress.assumingMemoryBound(to: CChar.self)
      return Int(libssh2_channel_read_ex(pointer, stream, address, capacity))
    }
    guard count > 0 else { return (count, Data()) }
    return (count, Data(buffer.prefix(count)))
  }
  private func drain(client: IosSshClient, session: OpaquePointer, channel: IosSshChannel, stdout: inout Data, stderr: inout Data, deadline: DispatchTime) throws {
    while true {
      try ensureActive(client, deadline: deadline)
      var madeProgress = false
      for stream in [Int32(0), Int32(1)] {
        let chunk = try readChunk(channel: channel, stream: stream)
        if chunk.count > 0 {
          madeProgress = true
          if stream == 0 {
            stdout.append(chunk.data)
          } else {
            stderr.append(chunk.data)
          }
        } else if chunk.count < 0 && chunk.count != Int(LIBSSH2_ERROR_EAGAIN) {
          throw SshFailure(code: "T3_SSH_READ", message: "Remote read failed.")
        }
      }

      let endOfFile = libssh2_channel_eof(channel.pointer!) != 0
      if endOfFile && !madeProgress { return }
      if !madeProgress {
        try waitForIO(client: client, session: session, deadline: deadline, events: Int16(POLLIN))
      }
    }
  }

  private func waitForIO(client: IosSshClient, session: OpaquePointer?, deadline: DispatchTime, socket: Int32? = nil, events: Int16? = nil) throws {
    while true {
      try ensureActive(client, deadline: deadline)
      let descriptor = socket ?? client.socket
      guard descriptor >= 0 else {
        throw SshFailure(code: "T3_SSH_CONNECT", message: "SSH socket is unavailable.")
      }
      var requestedEvents = events ?? 0
      if let session {
        let directions = Int32(libssh2_session_block_directions(session))
        if directions & Int32(LIBSSH2_SESSION_BLOCK_INBOUND) != 0 {
          requestedEvents |= Int16(POLLIN)
        }
        if directions & Int32(LIBSSH2_SESSION_BLOCK_OUTBOUND) != 0 {
          requestedEvents |= Int16(POLLOUT)
        }
      }
      if requestedEvents == 0 {
        requestedEvents = Int16(POLLIN | POLLOUT)
      }
      requestedEvents |= Int16(POLLERR | POLLHUP)

      let remaining = remainingNanoseconds(until: deadline)
      let pollSlice: UInt64 = 250_000_000
      let milliseconds = Int32(min(remaining / 1_000_000, pollSlice / 1_000_000))
      var descriptors = [
        pollfd(fd: descriptor, events: requestedEvents, revents: 0),
        pollfd(fd: client.wakeDescriptor(), events: Int16(POLLIN), revents: 0)
      ]
      let result = descriptors.withUnsafeMutableBufferPointer { buffer in
        Darwin.poll(buffer.baseAddress, nfds_t(buffer.count), milliseconds)
      }
      if result < 0 {
        if errno == EINTR { continue }
        throw SshFailure(code: "T3_SSH_SOCKET", message: "SSH socket wait failed.")
      }
      if descriptors[1].revents != 0 {
        client.consumeWake()
        if client.isStopping() {
          throw SshFailure(code: "T3_SSH_DISCONNECTED", message: "SSH session was disconnected.")
        }
      }
      if descriptors[0].revents & Int16(POLLNVAL) != 0 {
        throw SshFailure(code: "T3_SSH_SOCKET", message: "SSH socket became invalid.")
      }
      if descriptors[0].revents != 0 {
        return
      }
      if result == 0 {
        if remaining > pollSlice { continue }
        throw SshFailure(code: "T3_SSH_TIMEOUT", message: "SSH operation timed out.")
      }
    }
  }

  private func startForwardPipe(_ pipe: ForwardPipe, client: IosSshClient, remoteHost: String, remotePort: Int32) {
    guard !pipe.started, !pipe.closed else { return }
    pipe.started = true
    pipe.connection.stateUpdateHandler = { [weak self, weak client, weak pipe] state in
      guard let self, let client, let pipe else { return }
      client.queue.async {
        guard !pipe.closed else { return }
        switch state {
        case .ready:
          guard pipe.channel == nil else { return }
          do {
            guard let session = client.session else {
              throw SshFailure(code: "T3_SSH_FORWARD", message: "SSH session is unavailable.")
            }
            let channel = try self.openDirectChannel(client: client, session: session, remoteHost: remoteHost, remotePort: remotePort, deadline: self.deadline(after: Self.connectTimeout))
            pipe.channel = channel
            client.channels[ObjectIdentifier(channel)] = channel
            self.receiveLocal(pipe, client: client)
            self.pumpRemote(pipe, client: client)
          } catch {
            self.finishForwardPipe(pipe, client: client)
          }
        case .failed, .cancelled:
          self.finishForwardPipe(pipe, client: client)
        default:
          break
        }
      }
    }
    pipe.connection.start(queue: client.queue)
  }

  private func receiveLocal(_ pipe: ForwardPipe, client: IosSshClient) {
    guard !pipe.closed, !pipe.localEOF, !pipe.localReceivePending else { return }
    pipe.localReceivePending = true
    pipe.connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self, weak client, weak pipe] data, _, isComplete, error in
      guard let self, let client, let pipe else { return }
      client.queue.async {
        pipe.localReceivePending = false
        guard !pipe.closed else { return }
        self.handleLocal(pipe, client: client, data: data, isComplete: isComplete, error: error)
      }
    }
  }

  private func handleLocal(_ pipe: ForwardPipe, client: IosSshClient, data: Data?, isComplete: Bool, error: NWError?) {
    guard let channel = pipe.channel, let session = client.session else {
      finishForwardPipe(pipe, client: client)
      return
    }
    do {
      if let data, !data.isEmpty {
        try write(client: client, session: session, channel: channel, data: data, deadline: deadline(after: Self.connectTimeout))
      }
      if isComplete {
        pipe.localEOF = true
        try sendEOF(client: client, session: session, channel: channel, deadline: deadline(after: Self.connectTimeout))
      }
    } catch {
      finishForwardPipe(pipe, client: client)
      return
    }
    if error != nil {
      finishForwardPipe(pipe, client: client)
      return
    }
    receiveLocal(pipe, client: client)
    pumpRemote(pipe, client: client)
  }

  private func pumpRemote(_ pipe: ForwardPipe, client: IosSshClient) {
    guard !pipe.closed, !pipe.remoteEOF, !pipe.remoteSendPending,
          let channel = pipe.channel, let session = client.session,
          let pointer = channel.pointer else { return }

    var buffer = Data(repeating: 0, count: 8192)
    let count = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
      guard let baseAddress = rawBuffer.baseAddress else { return 0 }
      return Int(libssh2_channel_read_ex(pointer, 0, baseAddress.assumingMemoryBound(to: CChar.self), rawBuffer.count))
    }
    if count > 0 {
      let data = Data(buffer.prefix(count))
      pipe.remoteSendPending = true
      pipe.connection.send(content: data, completion: .contentProcessed { [weak self, weak client, weak pipe] error in
        guard let self, let client, let pipe else { return }
        client.queue.async {
          pipe.remoteSendPending = false
          guard !pipe.closed else { return }
          if error != nil {
            self.finishForwardPipe(pipe, client: client)
          } else {
            self.pumpRemote(pipe, client: client)
          }
        }
      })
      return
    }

    let endOfFile = libssh2_channel_eof(pointer) != 0
    if count < 0 && count != Int(LIBSSH2_ERROR_EAGAIN) {
      finishForwardPipe(pipe, client: client)
      return
    }
    if endOfFile {
      pipe.remoteEOF = true
      finishForwardPipe(pipe, client: client)
      return
    }

    do {
      try waitForIO(client: client, session: session, deadline: deadline(after: 1_000_000_000), events: Int16(POLLIN))
    } catch let failure as SshFailure where failure.code == "T3_SSH_TIMEOUT" {
      client.queue.async { [weak self, weak client, weak pipe] in
        guard let self, let client, let pipe else { return }
        self.pumpRemote(pipe, client: client)
      }
      return
    } catch {
      finishForwardPipe(pipe, client: client)
      return
    }
    client.queue.asyncAfter(deadline: .now() + .milliseconds(10)) { [weak self, weak client, weak pipe] in
      guard let self, let client, let pipe else { return }
      self.pumpRemote(pipe, client: client)
    }
  }

  private func removeListener(_ listener: NWListener, client: IosSshClient) {
    client.listeners.removeValue(forKey: ObjectIdentifier(listener))
    listener.newConnectionHandler = nil
    listener.stateUpdateHandler = nil
    listener.cancel()
  }

  private func finishForwardPipe(_ pipe: ForwardPipe, client: IosSshClient) {
    guard !pipe.closed else { return }
    pipe.closed = true
    client.pipes.removeValue(forKey: ObjectIdentifier(pipe))
    pipe.connection.stateUpdateHandler = nil
    pipe.connection.cancel()
    if let channel = pipe.channel {
      pipe.channel = nil
      client.channels.removeValue(forKey: ObjectIdentifier(channel))
      closeChannel(client: client, channel: channel)
    }
  }

  private func closeChannel(client: IosSshClient, channel: IosSshChannel) {
    guard let pointer = channel.pointer else { return }
    channel.pointer = nil
    // A stopped session releases its channels together after shutting down the socket.
    guard !client.isStopping() else { return }
    if let session = client.session {
      var closeStatus = libssh2_channel_close(pointer)
      if closeStatus == Int32(LIBSSH2_ERROR_EAGAIN) && !client.isStopping() {
        let closeDeadline = deadline(after: 2_000_000_000)
        while closeStatus == Int32(LIBSSH2_ERROR_EAGAIN), remainingNanoseconds(until: closeDeadline) > 0 {
          do {
            try waitForIO(client: client, session: session, deadline: closeDeadline)
          } catch {
            break
          }
          closeStatus = libssh2_channel_close(pointer)
        }
      }
      if closeStatus != 0 && closeStatus != Int32(LIBSSH2_ERROR_EAGAIN) {
        client.recordTeardownFailure(SshFailure(code: "T3_SSH_CHANNEL_CLOSE", message: "SSH channel close failed."))
      }
      if closeStatus == 0 {
        var waitStatus = libssh2_channel_wait_closed(pointer)
        if waitStatus == Int32(LIBSSH2_ERROR_EAGAIN) && !client.isStopping() {
          let waitDeadline = deadline(after: 2_000_000_000)
          while waitStatus == Int32(LIBSSH2_ERROR_EAGAIN), remainingNanoseconds(until: waitDeadline) > 0 {
            do {
              try waitForIO(client: client, session: session, deadline: waitDeadline)
            } catch {
              break
            }
            waitStatus = libssh2_channel_wait_closed(pointer)
          }
        }
        if waitStatus != 0 && waitStatus != Int32(LIBSSH2_ERROR_EAGAIN) {
          client.recordTeardownFailure(SshFailure(code: "T3_SSH_CHANNEL_WAIT", message: "SSH channel did not close cleanly."))
        }
      }
    }
    if let session = client.session {
      do {
        try retryStatus(client: client, session: session, deadline: deadline(after: 2_000_000_000), code: "T3_SSH_CHANNEL_FREE", message: "SSH channel release failed.") {
          libssh2_channel_free(pointer)
        }
      } catch {
        if !client.isStopping() {
          client.recordTeardownFailure(SshFailure(code: "T3_SSH_CHANNEL_FREE", message: "SSH channel release failed."))
        }
      }
    }
  }

  private func abandonSession(_ client: IosSshClient) {
    if client.socket >= 0 {
      shutdown(client.socket, SHUT_RDWR)
    }
    if let session = client.session {
      let freeStatus = libssh2_session_free(session)
      if freeStatus != 0 {
        client.recordTeardownFailure(SshFailure(code: "T3_SSH_SESSION_FREE", message: "SSH session release failed."))
      }
      client.session = nil
    }
    if client.socket >= 0 {
      Darwin.close(client.socket)
      client.socket = -1
    }
  }

  private func close(_ client: IosSshClient) {
    guard !client.didClose else { return }
    client.didClose = true
    client.requestStop()

    let pendingForwards = Array(client.pendingForwards.values)
    client.pendingForwards.removeAll()
    for gate in pendingForwards {
      _ = gate.fail(SshFailure(code: "T3_SSH_DISCONNECTED", message: "SSH session was disconnected."))
    }

    let listeners = Array(client.listeners.values)
    client.listeners.removeAll()
    for listener in listeners {
      listener.newConnectionHandler = nil
      listener.stateUpdateHandler = nil
      listener.cancel()
    }

    let pipes = Array(client.pipes.values)
    for pipe in pipes {
      finishForwardPipe(pipe, client: client)
    }

    let channels = Array(client.channels.values)
    client.channels.removeAll()
    for channel in channels {
      closeChannel(client: client, channel: channel)
    }

    abandonSession(client)
    client.closeWakeDescriptors()
  }
}

public class T3SshModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3Ssh")
    AsyncFunction("inspectHost") { (host: String, port: Int) in try await IosSshStore.shared.inspect(host: host, port: port) }
    AsyncFunction("connect") { (host: String, port: Int, username: String, password: String?, privateKey: String?, passphrase: String?, expectedFingerprint: String?) in try await IosSshStore.shared.connect(host: host, port: port, username: username, password: password, privateKey: privateKey, passphrase: passphrase, expected: expectedFingerprint) }
    AsyncFunction("exec") { (sessionId: String, command: String, stdin: String?) in try await IosSshStore.shared.exec(id: sessionId, command: command, stdin: stdin) }
    AsyncFunction("forward") { (sessionId: String, remoteHost: String, remotePort: Int) in try await IosSshStore.shared.forward(id: sessionId, remoteHost: remoteHost, remotePort: remotePort) }
    AsyncFunction("disconnect") { (sessionId: String) in try await IosSshStore.shared.disconnect(id: sessionId) }
    OnDestroy { IosSshStore.shared.disconnectAll() }
  }
}
