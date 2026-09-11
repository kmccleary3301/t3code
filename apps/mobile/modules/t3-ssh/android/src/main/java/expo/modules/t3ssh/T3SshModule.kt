package expo.modules.t3ssh

import android.util.Base64
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Session
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private const val INSPECT_TIMEOUT_MS = 15_000
private const val CONNECT_TIMEOUT_MS = 20_000
private const val COMMAND_TIMEOUT_MS = 90_000L
private const val POLL_INTERVAL_NANOS = 50_000_000L
private const val COLLECTOR_CLEANUP_TIMEOUT_NANOS = 1_000_000_000L

private class FingerprintRepository(private val expected: String?) : HostKeyRepository {
  var fingerprint: String? = null

  override fun check(host: String, key: ByteArray): Int {
    fingerprint = fingerprint(key)
    return when {
      expected == null -> HostKeyRepository.NOT_INCLUDED
      expected == fingerprint -> HostKeyRepository.OK
      else -> HostKeyRepository.CHANGED
    }
  }

  override fun add(hostkey: HostKey?, ui: com.jcraft.jsch.UserInfo?) = Unit
  override fun remove(host: String?, type: String?) = Unit
  override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
  override fun getKnownHostsRepositoryID(): String = "t3-mobile"
  override fun getHostKey(): Array<HostKey> = emptyArray()
  override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()

  companion object {
    fun fingerprint(key: ByteArray): String =
      "SHA256:" + Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(key),
        Base64.NO_WRAP,
      ).trimEnd('=')
  }
}

private class Client(val session: Session)

private class StreamCollector(private val input: InputStream) : Runnable {
  val output = ByteArrayOutputStream()

  @Volatile
  var failure: Throwable? = null

  override fun run() {
    try {
      input.copyTo(output)
    } catch (error: Throwable) {
      failure = error
    }
  }

  fun close(): Throwable? =
    try {
      input.close()
      null
    } catch (error: Throwable) {
      error
    }
}

private fun remainingNanos(deadlineNanos: Long): Long = deadlineNanos - System.nanoTime()

private fun waitSliceNanos(remaining: Long): Long = minOf(remaining, POLL_INTERVAL_NANOS)

private fun sleepForNanos(durationNanos: Long) {
  val millis = durationNanos / 1_000_000L
  val nanos = (durationNanos % 1_000_000L).toInt()
  Thread.sleep(millis, nanos)
}

private fun commandConnectTimeoutMillis(deadlineNanos: Long): Int {
  val remaining = remainingNanos(deadlineNanos)
  if (remaining <= 0) throw Exception("T3_SSH_COMMAND_TIMEOUT")
  return (remaining / 1_000_000L).coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
}

private fun awaitChannelClosed(channel: ChannelExec, deadlineNanos: Long) {
  while (!channel.isClosed) {
    val remaining = remainingNanos(deadlineNanos)
    if (remaining <= 0) throw Exception("T3_SSH_COMMAND_TIMEOUT")
    try {
      sleepForNanos(waitSliceNanos(remaining))
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      throw Exception("T3_SSH_COMMAND_INTERRUPTED", error)
    }
  }
}

private fun joinUntil(thread: Thread, deadlineNanos: Long): Throwable? {
  while (thread.isAlive) {
    val remaining = remainingNanos(deadlineNanos)
    if (remaining <= 0) return Exception("T3_SSH_COMMAND_TIMEOUT")
    val wait = waitSliceNanos(remaining)
    try {
      thread.join(wait / 1_000_000L, (wait % 1_000_000L).toInt())
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      return Exception("T3_SSH_COMMAND_INTERRUPTED", error)
    }
  }
  return null
}

private fun joinForCleanup(thread: Thread, deadlineNanos: Long): Throwable? {
  while (thread.isAlive) {
    val remaining = remainingNanos(deadlineNanos)
    if (remaining <= 0) return Exception("T3_SSH_COLLECTOR_CLEANUP_TIMEOUT")
    val wait = waitSliceNanos(remaining)
    try {
      thread.join(wait / 1_000_000L, (wait % 1_000_000L).toInt())
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      return Exception("T3_SSH_COLLECTOR_CLEANUP_INTERRUPTED", error)
    }
  }
  return null
}

private fun mergeFailures(current: Throwable?, next: Throwable?): Throwable? {
  if (next == null) return current
  if (current == null) return next
  if (current !== next) current.addSuppressed(next)
  return current
}

private fun closeSession(session: Session): Throwable? =
  try {
    session.disconnect()
    null
  } catch (error: Throwable) {
    error
  }

private fun executeChannel(channel: ChannelExec, command: String, stdin: String?): Map<String, Any> {
  val deadlineNanos = System.nanoTime() + COMMAND_TIMEOUT_MS * 1_000_000L
  var result: Map<String, Any>? = null
  var failure: Throwable? = null
  var collectors: List<StreamCollector> = emptyList()
  val startedThreads = mutableListOf<Thread>()

  try {
    channel.setCommand(command)
    channel.setInputStream(ByteArrayInputStream((stdin ?: "").toByteArray(Charsets.UTF_8)))

    val stdoutCollector = StreamCollector(channel.inputStream)
    val stderrCollector = StreamCollector(channel.errStream)
    collectors = listOf(stdoutCollector, stderrCollector)

    val stdoutThread = Thread(stdoutCollector, "t3-ssh-stdout").apply { isDaemon = true }
    val stderrThread = Thread(stderrCollector, "t3-ssh-stderr").apply { isDaemon = true }
    for (thread in listOf(stdoutThread, stderrThread)) {
      thread.start()
      startedThreads += thread
    }

    channel.connect(commandConnectTimeoutMillis(deadlineNanos))
    awaitChannelClosed(channel, deadlineNanos)

    for (thread in startedThreads) {
      failure = mergeFailures(failure, joinUntil(thread, deadlineNanos))
    }
    for (collector in collectors) {
      failure = mergeFailures(failure, collector.failure)
    }
    if (failure == null) {
      result = mapOf(
        "stdout" to stdoutCollector.output.toString(Charsets.UTF_8.name()),
        "stderr" to stderrCollector.output.toString(Charsets.UTF_8.name()),
        "exitCode" to channel.exitStatus,
      )
    }
  } catch (error: Throwable) {
    failure = mergeFailures(failure, error)
  } finally {
    failure = mergeFailures(
      failure,
      try {
        channel.disconnect()
        null
      } catch (error: Throwable) {
        error
      },
    )
    for (collector in collectors) {
      failure = mergeFailures(failure, collector.close())
    }
    val cleanupDeadlineNanos = System.nanoTime() + COLLECTOR_CLEANUP_TIMEOUT_NANOS
    for (thread in startedThreads) {
      failure = mergeFailures(failure, joinForCleanup(thread, cleanupDeadlineNanos))
    }
    for (collector in collectors) {
      failure = mergeFailures(failure, collector.failure)
    }
  }

  if (failure != null) throw failure as Throwable
  return result ?: throw Exception("T3_SSH_COMMAND_NO_RESULT")
}

class T3SshModule : Module() {
  private val clients = ConcurrentHashMap<String, Client>()
  private val lifecycleLock = Any()
  private var destroyed = false

  private fun requireClient(sessionId: String): Client =
    clients[sessionId] ?: throw Exception("T3_SSH_SESSION_NOT_FOUND")

  private fun requireCurrentClient(sessionId: String, client: Client) {
    if (clients[sessionId] !== client) throw Exception("T3_SSH_SESSION_NOT_FOUND")
  }

  override fun definition() = ModuleDefinition {
    Name("T3Ssh")

    AsyncFunction("inspectHost") { host: String, port: Int ->
      val repository = FingerprintRepository(null)
      val session = JSch().getSession("t3-probe", host, port)
      session.hostKeyRepository = repository
      try {
        session.connect(INSPECT_TIMEOUT_MS)
        throw Exception("T3_SSH_HOST_KEY_REQUIRED:${repository.fingerprint ?: ""}")
      } catch (error: JSchException) {
        val fingerprint = repository.fingerprint
          ?: throw Exception("T3_SSH_CONNECT:${error.message ?: "connection failed"}")
        mapOf("fingerprint" to fingerprint)
      } finally {
        session.disconnect()
      }
    }

    AsyncFunction("connect") { host: String, port: Int, username: String, password: String?, privateKey: String?, passphrase: String?, expectedFingerprint: String? ->
      require(!password.isNullOrBlank() || !privateKey.isNullOrBlank()) { "T3_SSH_AUTH_REQUIRED" }
      val jsch = JSch()
      if (!privateKey.isNullOrBlank()) {
        try {
          jsch.addIdentity("t3-mobile", privateKey.toByteArray(Charsets.UTF_8), null, passphrase?.toByteArray(Charsets.UTF_8))
        } catch (error: JSchException) {
          throw Exception("T3_SSH_AUTH:Private key could not be loaded.", error)
        }
      }
      val repository = FingerprintRepository(expectedFingerprint)
      val session = jsch.getSession(username, host, port)
      session.setConfig("StrictHostKeyChecking", "yes")
      session.hostKeyRepository = repository
      if (!password.isNullOrBlank()) session.setPassword(password)

      try {
        session.connect(CONNECT_TIMEOUT_MS)
        val id = UUID.randomUUID().toString()
        synchronized(lifecycleLock) {
          if (destroyed) throw Exception("T3_SSH_MODULE_DESTROYED")
          clients[id] = Client(session)
        }
        mapOf("sessionId" to id, "fingerprint" to (repository.fingerprint ?: ""))
      } catch (error: Throwable) {
        closeSession(session)?.let(error::addSuppressed)
        val fingerprint = repository.fingerprint
        if (fingerprint != null && fingerprint != expectedFingerprint) {
          val code = if (expectedFingerprint.isNullOrBlank()) "T3_SSH_HOST_KEY_REQUIRED" else "T3_SSH_HOST_KEY_MISMATCH"
          throw Exception("$code:Received $fingerprint", error)
        }
        if (error is JSchException && (error.message?.startsWith("Auth fail") == true || error.message?.startsWith("Auth cancel") == true)) {
          throw Exception("T3_SSH_AUTH:SSH authentication failed.", error)
        }
        throw error
      }
    }

    AsyncFunction("exec") { sessionId: String, command: String, stdin: String? ->
      val client = requireClient(sessionId)
      val channel = synchronized(client) {
        requireCurrentClient(sessionId, client)
        client.session.openChannel("exec") as ChannelExec
      }
      executeChannel(channel, command, stdin)
    }

    AsyncFunction("forward") { sessionId: String, remoteHost: String, remotePort: Int ->
      val client = requireClient(sessionId)
      val localPort = synchronized(client) {
        requireCurrentClient(sessionId, client)
        client.session.setPortForwardingL("127.0.0.1", 0, remoteHost, remotePort)
      }
      mapOf("localPort" to localPort)
    }

    AsyncFunction("disconnect") { sessionId: String ->
      val client = clients.remove(sessionId) ?: return@AsyncFunction null
      val failure = synchronized(client) { closeSession(client.session) }
      if (failure != null) throw failure as Throwable
      null
    }

    OnDestroy {
      val retained = synchronized(lifecycleLock) {
        destroyed = true
        clients.values.toList().also { clients.clear() }
      }
      var failure: Throwable? = null
      for (client in retained) {
        failure = mergeFailures(failure, synchronized(client) { closeSession(client.session) })
      }
      if (failure != null) throw failure as Throwable
    }
  }
}
