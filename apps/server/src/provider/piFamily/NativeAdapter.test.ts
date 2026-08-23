import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makePiFamilyAdapter } from "./NativeAdapter.ts";
import {
  BoundedNativeTraceRecorder,
  type NativeTraceSessionIdentity,
  type NativeTraceSink,
} from "./NativeTrace.ts";

type Runtime = "pi" | "omp";
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

function decodeTraceFrame(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const value = decodeUnknownJson(new TextDecoder().decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object trace frame");
  }
  return value as Readonly<Record<string, unknown>>;
}

const capabilities = (runtime: Runtime, modelSwitch = true) => ({
  runtime,
  runtimeVersion: "test-runtime",
  protocolVersion: runtime === "omp" ? 2 : 1,
  supportedProtocolVersions: runtime === "omp" ? [1, 2] : [1],
  ...(runtime === "omp"
    ? {
        negotiatedProtocolVersion: 2,
        transport: {
          strictLfJsonl: true,
          maxFrameBytes: 1_048_576,
          maxReassembledFrameBytes: 67_108_864,
          chunking: true,
        },
      }
    : {
        transport: { strictLfJsonl: true, chunking: false },
      }),
  models: { discover: true, switch: modelSwitch },
  thinking: { discover: true, switch: true },
  commands: { discover: true, invokeNative: true },
  sessions: {
    resume: true,
    tree: true,
    fork: true,
    compact: true,
    nativeCheckpoint: true,
    completeTurnRollback: false,
  },
  ui: {
    select: true,
    confirm: true,
    input: true,
    editor: true,
    notify: true,
    status: true,
    widget: true,
    openUrl: false,
    arbitraryTerminalComponents: false,
  },
  tasks: {
    lifecycle: true,
    nested: runtime === "omp",
    childTranscript: false,
    workflows: runtime === "omp",
    background: runtime === "omp",
    targetedCancellation: false,
  },
});

const makeNativeScript = (runtime: Runtime, malformed = false, modelSwitch = true): string => {
  const lines = [
    'const readline = require("node:readline");',
    'const out = value => process.stdout.write(JSON.stringify(value) + "\\n");',
  ];
  if (runtime === "omp") {
    lines.push(
      'out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });',
    );
  }
  lines.push(
    "const rl = readline.createInterface({ input: process.stdin });",
    'rl.on("line", line => {',
    "  const command = JSON.parse(line);",
    '  if (command.type === "negotiate_protocol") out({ id: command.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });',
    '  if (command.type === "get_capabilities") out({ id: command.id, type: "response", command: "get_capabilities", success: true, data: ' +
      JSON.stringify(capabilities(runtime, modelSwitch)) +
      " });",
    '  if (command.type === "set_subagent_subscription") out({ id: command.id, type: "response", command: "set_subagent_subscription", success: true });',
    ...(runtime === "omp"
      ? [
          '  if (command.type === "checkpoint") out({ id: command.id, type: "response", command: "checkpoint", success: true, data: { sessionId: "test-session", checkpointId: "checkpoint-1" } });',
          '  if (command.type === "rewind") out({ id: command.id, type: "response", command: "rewind", success: true, data: { checkpointId: command.checkpointId, rewound: true } });',
        ]
      : [
          '  if (command.type === "capture_checkpoint") out({ id: command.id, type: "response", command: "capture_checkpoint", success: true, data: { runtime: "pi", sessionId: "test-session", leafEntryId: "leaf-1" } });',
          '  if (command.type === "restore_checkpoint") out({ id: command.id, type: "response", command: "restore_checkpoint", success: true });',
        ]),
    '  if (command.type === "extension_ui_response" && command.id === "approval-1" && command.confirmed === true) out({ type: "message_update", delta: { text: "confirmed" } });',
    '  if (command.type === "extension_ui_response" && command.id.startsWith("ui-")) out({ type: "message_update", delta: { text: command.id + ":" + String(command.confirmed ?? command.value) } });',
    '  if (command.type === "prompt") {',
    '    if (command.message === "local-command") {',
    '      out({ id: command.id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } });',
    "      return;",
    "    }",
    '    out({ id: command.id, type: "response", command: "prompt", success: true });',
    '    if (command.message === "unknown-events") {',
    '      out({ type: "future_native_event", requestId: "corr-1", token: "secret-token", content: "secret body", prompt: "private prompt", input: "private input", output: "private output", query: "private query", description: "private description", command: "private command", cwd: "/Users/private", home: "/Users/private", path: "/tmp/private", email: "private@example.com", username: "private-user", env: { AUTH_TOKEN: "opaque-canary" }, usage: { inputTokens: 1 }, pid: 1234, extra: { path: "/tmp/nested-private", command: "nested-private-command" }, status: "pending" });',
    '      out({ type: "future_native_large_" + "t".repeat(20_000), id: "i".repeat(20_000), requestId: "r".repeat(20_000), taskId: "k".repeat(20_000), items: Array.from({ length: 64 }, () => "x".repeat(600)) });',
    ...(runtime === "omp"
      ? ['      out({ type: "agent_end", isTerminal: true });']
      : [
          '      out({ type: "turn_end", id: command.id });',
          '      out({ type: "agent_end", willRetry: false });',
          '      out({ type: "agent_settled" });',
        ]),
    "      return;",
    "    }",
    '    if (command.message === "portable-ui") {',
    ...(runtime === "omp"
      ? ['      out({ type: "agent_start" });']
      : ['      out({ type: "turn_start", id: command.id });']),
    '      out({ type: "extension_ui_request", id: "ui-confirm", method: "confirm", title: "Confirm", message: "Continue?" });',
    '      out({ type: "extension_ui_request", id: "ui-select", method: "select", title: "Choose", options: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }] });',
    '      out({ type: "extension_ui_request", id: "ui-input", method: "input", title: "Name", placeholder: "value" });',
    '      out({ type: "extension_ui_request", id: "ui-editor", method: "editor", title: "Edit", prefill: "before" });',
    ...(runtime === "omp"
      ? ['      out({ type: "agent_end", isTerminal: true });']
      : [
          '      out({ type: "turn_end", id: command.id });',
          '      out({ type: "agent_end", willRetry: false });',
          '      out({ type: "agent_settled" });',
        ]),
    "      return;",
    "    }",
    '    if (command.message === "anonymous-pi-lifecycle") {',
    '      out({ type: "agent_start" });',
    '      out({ type: "turn_start" });',
    '      out({ type: "message_update", delta: { text: "anonymous pi complete" } });',
    '      out({ type: "message_end", message: { id: "assistant-anonymous", role: "assistant", content: [{ type: "text", text: "anonymous pi complete" }], stopReason: "stop" } });',
    '      out({ type: "turn_end" });',
    '      out({ type: "agent_end" });',
    '      out({ type: "agent_settled" });',
    "      return;",
    "    }",
    ...(malformed
      ? [
          '    if (command.message === "malformed") {',
          '      process.stdout.write("{not-json\\n");',
          '      process.stdout.write("{still-not-json\\n");',
          '      out({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "Approve", message: "Proceed?" });',
          '      out({ type: "tool_execution_start", toolName: "subagent", id: "tool-1" });',
          '      out({ type: "tool_execution_end", toolName: "subagent", id: "tool-1" });',
          '      out({ type: "message_update", delta: { text: "after malformed" } });',
          ...(runtime === "omp"
            ? ['      out({ type: "agent_end", isTerminal: true });']
            : [
                '      out({ type: "turn_end", id: command.id });',
                '      out({ type: "agent_end", willRetry: false });',
                '      out({ type: "agent_settled" });',
              ]),
          "      return;",
          "    }",
        ]
      : []),
    ...(runtime === "omp"
      ? [
          '    out({ type: "agent_start" });',
          '    out({ type: "turn_start" });',
          '    out({ type: "turn_end" });',
          '    out({ type: "turn_start" });',
        ]
      : ['    out({ type: "turn_start", id: command.id });']),
    '    out({ type: "message_update", delta: { text: "hello from native" } });',
    '    out({ type: "message_end", message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "hello from native" }], stopReason: "stop" } });',
    ...(runtime === "omp"
      ? []
      : [
          '    out({ type: "turn_end", id: command.id });',
          '    out({ type: "agent_end", willRetry: false });',
          '    out({ type: "agent_settled" });',
        ]),
    "  }",
    '  if (command.type === "abort") out({ id: command.id, type: "response", command: "abort", success: true });',
    "});",
  );
  return lines.join("\n");
};

type TraceRecord =
  | {
      readonly kind: "bytes";
      readonly stream: "stdin" | "stdout" | "stderr";
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: string | null;
    };

const makeTraceNativeScript = (): string =>
  [
    'const readline = require("node:readline");',
    `const capabilities = ${JSON.stringify(capabilities("pi"))};`,
    'const out = value => process.stdout.write(JSON.stringify(value) + "\\n");',
    "const rl = readline.createInterface({ input: process.stdin });",
    'rl.on("line", line => {',
    "  const command = JSON.parse(line);",
    '  if (command.type === "get_capabilities") out({ id: command.id, type: "response", command: "get_capabilities", success: true, data: capabilities });',
    '  if (command.type === "prompt") {',
    "    process.stderr.write(Buffer.from([128, 0, 65]));",
    '    out({ id: command.id, type: "response", command: "prompt", success: true });',
    '    setTimeout(() => process.stdout.write("TAIL", () => process.stderr.write(Buffer.from([66]), () => process.exit(7))), 25);',
    "  }",
    "});",
  ].join("\n");

const makeTraceSink = (
  records: TraceRecord[],
  onBytes?: (stream: "stdin" | "stdout" | "stderr") => void,
): NativeTraceSink => ({
  recordBytes: (stream, bytes) => {
    onBytes?.(stream);
    records.push({ kind: "bytes", stream, bytes: new Uint8Array(bytes) });
  },
  recordExit: (code, signal) => {
    records.push({ kind: "exit", code, signal });
  },
  invalidate: () => {},
});

const concatTraceBytes = (
  records: ReadonlyArray<Extract<TraceRecord, { readonly kind: "bytes" }>>,
): Uint8Array => {
  const result = new Uint8Array(
    records.reduce((total, record) => total + record.bytes.byteLength, 0),
  );
  let offset = 0;
  for (const record of records) {
    result.set(record.bytes, offset);
    offset += record.bytes.byteLength;
  }
  return result;
};

const nextEvent = (stream: Stream.Stream<ProviderRuntimeEvent>) =>
  Stream.runHead(stream).pipe(Effect.timeout("2 seconds"));

describe("Pi-family native adapter", () => {
  it.effect("records native boundary bytes in channel order and captures process exit", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-trace-thread");
      const instanceId = ProviderInstanceId.make("pi-trace-instance");
      const records: TraceRecord[] = [];
      const identities: NativeTraceSessionIdentity[] = [];
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeTraceNativeScript(), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        traceSinkFactory: {
          create: (identity) => {
            identities.push(identity);
            return makeTraceSink(records);
          },
        },
        instanceId,
      });

      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      const started = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.getOrUndefined(started)?.type, "session.started");
      const turn = yield* adapter.sendTurn({ threadId, input: "trace" });
      const exited = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.getOrUndefined(exited)?.type, "session.exited");
      assert.deepEqual(identities, [
        { threadId, provider, providerInstanceId: instanceId, runtime: "pi" },
      ]);

      const byteRecords = records.filter(
        (record): record is Extract<TraceRecord, { readonly kind: "bytes" }> =>
          record.kind === "bytes",
      );
      assert.deepEqual(
        byteRecords.slice(0, 3).map((record) => record.stream),
        ["stdin", "stdout", "stdin"],
      );
      assert.isTrue(byteRecords.some((record) => record.stream === "stderr"));
      const promptRecord = byteRecords.find(
        (record) => record.stream === "stdin" && decodeTraceFrame(record.bytes).type === "prompt",
      );
      assert.isDefined(promptRecord);
      if (promptRecord === undefined) return;
      const promptEnvelope = decodeTraceFrame(promptRecord.bytes) as {
        readonly id: string;
        readonly type: string;
      };
      assert.equal(promptEnvelope.id, turn.turnId);
      assert.deepEqual(
        Array.from(promptRecord.bytes),
        Array.from(new TextEncoder().encode(`${encodeUnknownJson(promptEnvelope)}\n`)),
      );

      const stderrBytes = concatTraceBytes(
        byteRecords.filter((record) => record.stream === "stderr"),
      );
      assert.deepEqual(Array.from(stderrBytes), [128, 0, 65, 66]);
      const stdoutText = new TextDecoder().decode(
        concatTraceBytes(byteRecords.filter((record) => record.stream === "stdout")),
      );
      assert.include(
        stdoutText,
        `${encodeUnknownJson({ id: turn.turnId, type: "response", command: "prompt", success: true })}\n`,
      );
      assert.include(stdoutText, "TAIL");
      const exit = records.find((record) => record.kind === "exit");
      assert.deepEqual(exit, { kind: "exit", code: 7, signal: null });
      assert.equal(records.at(-1)?.kind, "exit");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("records and finalizes one intentional exit for a stopped owned session", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-trace-stop-thread");
      const instanceId = ProviderInstanceId.make("pi-trace-stop-instance");
      const records: TraceRecord[] = [];
      let finalizations = 0;
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript("pi"), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        traceSinkFactory: {
          create: () => ({
            ...makeTraceSink(records),
            finalize: () => {
              finalizations += 1;
            },
          }),
        },
        instanceId,
      });

      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      const started = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.getOrUndefined(started)?.type, "session.started");

      yield* adapter.stopSession(threadId);

      assert.equal(yield* adapter.hasSession(threadId), false);
      const exits = records.filter(
        (record): record is Extract<TraceRecord, { readonly kind: "exit" }> =>
          record.kind === "exit",
      );
      assert.lengthOf(exits, 1);
      assert.equal(exits[0]?.signal, "SIGTERM");
      assert.equal(finalizations, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("bounds teardown when a native process ignores graceful termination", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-trace-force-stop-thread");
      const instanceId = ProviderInstanceId.make("pi-trace-force-stop-instance");
      const recorder = new BoundedNativeTraceRecorder({ maxDurationMs: 20_000 });
      const script = `${makeNativeScript("pi")}\nprocess.on("SIGTERM", () => {});\nsetTimeout(() => process.exit(0), 5_000);`;
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", script, "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        traceSinkFactory: { create: () => recorder },
        instanceId,
      });
      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* nextEvent(adapter.streamEvents);

      const startedAt = yield* Clock.currentTimeMillis;
      yield* adapter.stopSession(threadId);
      assert.isBelow((yield* Clock.currentTimeMillis) - startedAt, 4_500);
      const capture = recorder.snapshot().capture;
      assert.deepEqual(capture.exits, [{ sequence: 2, code: null, signal: "SIGKILL" }]);
      assert.equal(capture.truncated, false);
      assert.equal(capture.truncationReason, undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails and cleans up the owned session when tracing throws", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-trace-failure-thread");
      const instanceId = ProviderInstanceId.make("pi-trace-failure-instance");
      const records: TraceRecord[] = [];
      let invalidations = 0;
      let finalizations = 0;
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeTraceNativeScript(), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        traceSinkFactory: {
          create: () => ({
            ...makeTraceSink(records, (stream) => {
              if (stream === "stdout") throw new Error("trace sink failure");
            }),
            invalidate: () => {
              invalidations += 1;
            },
            finalize: () => {
              finalizations += 1;
            },
          }),
        },
        instanceId,
      });

      const result = yield* Effect.exit(
        adapter.startSession({
          threadId,
          provider,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
        }),
      );
      assert.equal(Exit.isFailure(result), true);
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.equal(
        records
          .filter((record) => record.kind === "bytes")
          .some((record) => record.stream === "stdout"),
        false,
      );
      assert.equal(invalidations, 1);
      assert.equal(finalizations, 0);
      assert.lengthOf(
        records.filter((record) => record.kind === "exit"),
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("invalidates a trace sink when the native process cannot spawn", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-trace-spawn-failure-thread");
      const instanceId = ProviderInstanceId.make("pi-trace-spawn-failure-instance");
      const recorder = new BoundedNativeTraceRecorder();
      let invalidations = 0;
      let finalizations = 0;
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: "/definitely/missing/t3-native-runtime",
        cwd: process.cwd(),
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        traceSinkFactory: {
          create: () => ({
            recordBytes: (stream, bytes) => recorder.recordBytes(stream, bytes),
            recordExit: (code, signal) => recorder.recordExit(code, signal),
            invalidate: () => {
              invalidations += 1;
              recorder.invalidate();
            },
            finalize: () => {
              finalizations += 1;
              recorder.finalize();
            },
          }),
        },
        instanceId,
      });
      const result = yield* Effect.exit(
        adapter.startSession({
          threadId,
          provider,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.equal(invalidations, 1);
      assert.equal(finalizations, 0);
      assert.isFalse(yield* adapter.hasSession(threadId));
      const capture = recorder.snapshot().capture;
      assert.isTrue(capture.truncated);
      assert.equal(capture.truncationReason, "lifecycle-error");
      assert.deepEqual(capture.exits, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("invalidates a partial OMP trace when startup negotiation fails", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("omp");
      const threadId = ThreadId.make("omp-trace-negotiation-failure-thread");
      const instanceId = ProviderInstanceId.make("omp-trace-negotiation-failure-instance");
      const recorder = new BoundedNativeTraceRecorder();
      let invalidations = 0;
      let finalizations = 0;
      const script = [
        'const readline = require("node:readline");',
        'const out = value => process.stdout.write(JSON.stringify(value) + "\\n");',
        'out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });',
        "const rl = readline.createInterface({ input: process.stdin });",
        'rl.on("line", line => {',
        "  const command = JSON.parse(line);",
        '  if (command.type === "negotiate_protocol") out({ id: command.id, type: "response", command: "negotiate_protocol", success: false, error: "unsupported" });',
        "});",
      ].join("\n");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "omp",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", script, "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        traceSinkFactory: {
          create: () => ({
            recordBytes: (stream, bytes) => recorder.recordBytes(stream, bytes),
            recordExit: (code, signal) => recorder.recordExit(code, signal),
            invalidate: () => {
              invalidations += 1;
              recorder.invalidate();
            },
            finalize: () => {
              finalizations += 1;
              recorder.finalize();
            },
          }),
        },
        instanceId,
      });
      const result = yield* Effect.exit(
        adapter.startSession({
          threadId,
          provider,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.equal(invalidations, 1);
      assert.equal(finalizations, 0);
      assert.isFalse(yield* adapter.hasSession(threadId));
      const capture = recorder.snapshot().capture;
      assert.isTrue(capture.truncated);
      assert.equal(capture.truncationReason, "lifecycle-error");
      assert.isAbove(capture.chunks.length, 0);
      assert.deepEqual(capture.exits, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not expose native stderr in exit events", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-stderr-secrecy-thread");
      const instanceId = ProviderInstanceId.make("pi-stderr-secrecy-instance");
      const script = `${makeNativeScript("pi")}\nsetTimeout(() => { process.stderr.write("password=opaque-canary /Users/private"); process.exit(9); }, 500);`;
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", script, "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });
      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      const exited = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "session.exited"),
        Stream.runHead,
        Effect.timeout("2 seconds"),
      );
      assert.isTrue(Option.isSome(exited));
      const event = Option.getOrUndefined(exited);
      assert.equal(event?.type, "session.exited");
      if (event?.type === "session.exited") {
        assert.equal(event.payload.reason, "Native runtime emitted diagnostics on stderr.");
        assert.notInclude(encodeUnknownJson(event), "opaque-canary");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  for (const runtime of ["pi", "omp"] as const) {
    it.effect(`starts ${runtime}, negotiates capabilities, and completes a prompt`, () =>
      Effect.gen(function* () {
        const provider = ProviderDriverKind.make(runtime);
        const threadId = ThreadId.make(`${runtime}-thread`);
        const adapter = yield* makePiFamilyAdapter({
          provider,
          runtime,
          binaryPath: process.execPath,
          cwd: process.cwd(),
          launchArguments: ["-e", makeNativeScript(runtime), "--"],
          requestTimeoutMs: 2_000,
          startupTimeoutMs: 2_000,
          maxLineBytes: 1_048_576,
          maxMessageBytes: 67_108_864,
          stderrLimitBytes: 16_384,
          instanceId: ProviderInstanceId.make(`${runtime}-instance`),
        });

        const session = yield* adapter.startSession({
          threadId,
          provider,
          providerInstanceId: ProviderInstanceId.make(`${runtime}-instance`),
          runtimeMode: "full-access",
        });
        assert.equal(session.threadId, threadId);
        assert.equal(yield* adapter.hasSession(threadId), true);
        assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");

        const started = yield* nextEvent(adapter.streamEvents);
        assert.equal(Option.isSome(started), true);
        if (Option.isNone(started)) return;
        assert.equal(started.value.type, "session.started");

        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
        assert.equal(turn.threadId, threadId);

        const turnStarted = yield* nextEvent(adapter.streamEvents);
        const content = yield* nextEvent(adapter.streamEvents);

        const assistantCompleted = yield* nextEvent(adapter.streamEvents);
        const turnCompleted = yield* nextEvent(adapter.streamEvents);
        assert.equal(Option.isSome(turnStarted), true);
        assert.equal(Option.isSome(content), true);
        assert.equal(Option.isSome(assistantCompleted), true);
        assert.equal(Option.isSome(turnCompleted), true);
        if (
          Option.isNone(turnStarted) ||
          Option.isNone(content) ||
          Option.isNone(assistantCompleted) ||
          Option.isNone(turnCompleted)
        )
          return;
        assert.equal(turnStarted.value.type, "turn.started");
        assert.equal(content.value.type, "content.delta");
        assert.equal(assistantCompleted.value.type, "item.completed");
        if (assistantCompleted.value.type === "item.completed") {
          assert.equal(assistantCompleted.value.payload.itemType, "assistant_message");
          assert.equal(assistantCompleted.value.payload.detail, "hello from native");
        }
        assert.equal(turnCompleted.value.type, "turn.completed");
        const captureCheckpoint = adapter.captureNativeCheckpoint;
        const restoreCheckpoint = adapter.restoreNativeCheckpoint;
        assert.isDefined(captureCheckpoint);
        assert.isDefined(restoreCheckpoint);
        if (!captureCheckpoint || !restoreCheckpoint) return;
        const checkpoint = yield* captureCheckpoint(threadId);
        assert.notEqual(checkpoint, undefined);
        yield* restoreCheckpoint(threadId, checkpoint);

        yield* adapter.stopSession(threadId);
        assert.equal(yield* adapter.hasSession(threadId), false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  for (const runtime of ["pi", "omp"] as const) {
    it.effect(
      `binds anonymous ${runtime} lifecycle frames to the accepted prompt exactly once`,
      () =>
        Effect.gen(function* () {
          const provider = ProviderDriverKind.make(runtime);
          const threadId = ThreadId.make(`${runtime}-anonymous-lifecycle-thread`);
          const instanceId = ProviderInstanceId.make(`${runtime}-anonymous-lifecycle-instance`);
          const adapter = yield* makePiFamilyAdapter({
            provider,
            runtime,
            binaryPath: process.execPath,
            cwd: process.cwd(),
            launchArguments: ["-e", makeNativeScript(runtime), "--"],
            requestTimeoutMs: 2_000,
            startupTimeoutMs: 2_000,
            maxLineBytes: 1_048_576,
            maxMessageBytes: 67_108_864,
            stderrLimitBytes: 16_384,
            instanceId,
          });

          yield* adapter.startSession({
            threadId,
            provider,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
          });
          yield* nextEvent(adapter.streamEvents);
          const turn = yield* adapter.sendTurn({ threadId, input: "anonymous-pi-lifecycle" });
          const events = yield* adapter.streamEvents.pipe(Stream.take(4), Stream.runCollect);
          assert.deepEqual(
            Array.from(events, (event) => event.type),
            ["turn.started", "content.delta", "item.completed", "turn.completed"],
          );
          const started = events[0];
          const completed = events[3];
          assert.equal(started?.turnId, turn.turnId);
          assert.equal(completed?.turnId, turn.turnId);
          yield* adapter.stopSession(threadId);
          assert.equal(yield* adapter.hasSession(threadId), false);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
  it.effect("settles an OMP local command that does not invoke an agent", () =>
    Effect.gen(function* () {
      const runtime = "omp" as const;
      const provider = ProviderDriverKind.make(runtime);
      const threadId = ThreadId.make("omp-local-command-thread");
      const instanceId = ProviderInstanceId.make("omp-local-command-instance");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime,
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript(runtime), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });
      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* nextEvent(adapter.streamEvents);

      const turn = yield* adapter.sendTurn({ threadId, input: "local-command" });
      const completed = Option.getOrUndefined(yield* nextEvent(adapter.streamEvents));
      assert.equal(completed?.type, "turn.completed");
      assert.equal(completed?.turnId, turn.turnId);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("redacts and bounds unknown native event details before persistence", () =>
    Effect.gen(function* () {
      const runtime = "pi" as const;
      const provider = ProviderDriverKind.make(runtime);
      const threadId = ThreadId.make("pi-unknown-event-thread");
      const instanceId = ProviderInstanceId.make("pi-unknown-event-instance");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime,
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript(runtime), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });
      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* nextEvent(adapter.streamEvents);
      yield* adapter.sendTurn({ threadId, input: "unknown-events" });

      const redacted = Option.getOrUndefined(yield* nextEvent(adapter.streamEvents));
      const bounded = Option.getOrUndefined(yield* nextEvent(adapter.streamEvents));
      assert.equal(redacted?.type, "runtime.warning");
      assert.equal(bounded?.type, "runtime.warning");
      const redactedDetail =
        redacted?.type === "runtime.warning" && typeof redacted.payload.detail === "object"
          ? (redacted.payload.detail as Record<string, unknown>)
          : undefined;
      const boundedDetail =
        bounded?.type === "runtime.warning" && typeof bounded.payload.detail === "object"
          ? (bounded.payload.detail as Record<string, unknown>)
          : undefined;
      for (const key of [
        "token",
        "content",
        "prompt",
        "input",
        "output",
        "query",
        "description",
        "command",
        "cwd",
        "home",
        "path",
        "email",
        "username",
        "env",
        "usage",
        "pid",
      ]) {
        assert.equal(redactedDetail?.[key], "[redacted]");
      }
      assert.deepEqual(redactedDetail?.extra, {
        path: "[redacted]",
        command: "[redacted]",
      });
      assert.equal(redactedDetail?.status, "pending");
      assert.notInclude(encodeUnknownJson(redacted), "opaque-canary");
      assert.equal(redacted?.raw, undefined);
      assert.equal(boundedDetail?.truncated, true);
      assert.equal("items" in (boundedDetail ?? {}), false);
      assert.equal(bounded?.raw, undefined);
      assert.isAtMost(String(bounded?.eventId ?? "").length, 512);
      for (const key of ["type", "id", "requestId", "taskId"]) {
        assert.isAtMost(String(boundedDetail?.[key] ?? "").length, 512);
      }
      const boundedJson = encodeUnknownJson(boundedDetail);
      assert.isAtMost(new TextEncoder().encode(boundedJson).byteLength, 8 * 1024);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("round-trips every interactive portable UI response over the native wire", () =>
    Effect.gen(function* () {
      const runtime = "omp" as const;
      const provider = ProviderDriverKind.make(runtime);
      const threadId = ThreadId.make("omp-portable-ui-thread");
      const instanceId = ProviderInstanceId.make("omp-portable-ui-instance");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime,
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript(runtime), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });

      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      yield* nextEvent(adapter.streamEvents);
      yield* adapter.sendTurn({ threadId, input: "portable-ui" });

      const turnStarted = yield* nextEvent(adapter.streamEvents);
      const confirm = yield* nextEvent(adapter.streamEvents);
      const select = yield* nextEvent(adapter.streamEvents);
      const input = yield* nextEvent(adapter.streamEvents);
      const editor = yield* nextEvent(adapter.streamEvents);
      const turnCompleted = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.getOrUndefined(turnStarted)?.type, "turn.started");
      assert.equal(Option.getOrUndefined(confirm)?.type, "request.opened");
      assert.equal(Option.getOrUndefined(select)?.type, "user-input.requested");
      assert.equal(Option.getOrUndefined(input)?.type, "request.opened");
      assert.equal(Option.getOrUndefined(editor)?.type, "request.opened");
      assert.equal(Option.getOrUndefined(turnCompleted)?.type, "turn.completed");

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("ui-confirm"), "accept");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("ui-select"), {
        choice: "beta",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("ui-input"), {
        value: "typed",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("ui-editor"), {
        value: "edited",
      });

      const expected = ["ui-confirm:true", "ui-select:beta", "ui-input:typed", "ui-editor:edited"];
      for (const detail of expected) {
        const response = Option.getOrUndefined(yield* nextEvent(adapter.streamEvents));
        assert.equal(response?.type, "content.delta");
        if (response?.type === "content.delta") {
          assert.equal(response.payload.delta, detail);
        }
      }
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("force-kills an unresponsive child and starts a replacement session", () =>
    Effect.gen(function* () {
      const runtime = "pi" as const;
      const provider = ProviderDriverKind.make(runtime);
      const threadId = ThreadId.make("pi-force-kill-thread");
      const instanceId = ProviderInstanceId.make("pi-force-kill-instance");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime,
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript(runtime), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });
      const start = {
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access" as const,
      };

      yield* adapter.startSession(start);
      yield* nextEvent(adapter.streamEvents);
      yield* adapter.sendTurn({ threadId, input: "arm-hang" });
      for (let index = 0; index < 4; index += 1) yield* nextEvent(adapter.streamEvents);
      yield* adapter.stopSession(threadId);
      assert.equal(yield* adapter.hasSession(threadId), false);

      yield* adapter.startSession(start);
      const restarted = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.getOrUndefined(restarted)?.type, "session.started");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("does not advertise model switching before native negotiation supports it", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("pi");
      const threadId = ThreadId.make("pi-model-capability-thread");
      const instanceId = ProviderInstanceId.make("pi-model-capability-instance");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "pi",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript("pi", false, false), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });

      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      assert.equal(adapter.capabilities.sessionModelSwitch, "unsupported");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("accepts the configured startup model when native switching is unsupported", () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("omp");
      const threadId = ThreadId.make("omp-startup-model-thread");
      const instanceId = ProviderInstanceId.make("omp-startup-model-instance");
      const modelSelection = { instanceId, model: "openai-codex/gpt-5.4" };
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime: "omp",
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript("omp", false, false), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });

      const session = yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
      });
      assert.equal(session.model, modelSelection.model);
      yield* nextEvent(adapter.streamEvents);

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection,
      });
      assert.equal(turn.threadId, threadId);
      const events = [];
      for (let index = 0; index < 4; index += 1) {
        const event = yield* nextEvent(adapter.streamEvents);
        if (Option.isSome(event)) events.push(event.value);
      }
      assert.equal(events.at(-1)?.type, "turn.completed");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("emits per-line decode errors and continues with later valid events", () =>
    Effect.gen(function* () {
      const runtime = "omp" as const;
      const provider = ProviderDriverKind.make(runtime);
      const threadId = ThreadId.make("omp-malformed-thread");
      const instanceId = ProviderInstanceId.make("omp-malformed-instance");
      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime,
        binaryPath: process.execPath,
        cwd: process.cwd(),
        launchArguments: ["-e", makeNativeScript(runtime, true), "--"],
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 2_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 16_384,
        instanceId,
      });

      yield* adapter.startSession({
        threadId,
        provider,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      });
      const started = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.isSome(started), true);
      yield* adapter.sendTurn({ threadId, input: "malformed" });

      const firstError = yield* nextEvent(adapter.streamEvents);
      const secondError = yield* nextEvent(adapter.streamEvents);
      const uiRequest = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.isSome(firstError), true);
      assert.equal(Option.isSome(secondError), true);
      assert.equal(Option.isSome(uiRequest), true);
      if (Option.isNone(firstError) || Option.isNone(secondError) || Option.isNone(uiRequest))
        return;
      assert.equal(firstError.value.type, "runtime.error");
      assert.equal(secondError.value.type, "runtime.error");
      assert.equal(uiRequest.value.type, "request.opened");
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval-1"), "accept");

      const toolStarted = yield* nextEvent(adapter.streamEvents);
      const toolCompleted = yield* nextEvent(adapter.streamEvents);
      const content = yield* nextEvent(adapter.streamEvents);
      const turnCompleted = yield* nextEvent(adapter.streamEvents);
      const confirmed = yield* nextEvent(adapter.streamEvents);
      assert.equal(Option.isSome(toolStarted), true);
      assert.equal(Option.isSome(toolCompleted), true);
      assert.equal(Option.isSome(content), true);
      assert.equal(Option.isSome(turnCompleted), true);
      assert.equal(Option.isSome(confirmed), true);
      if (
        Option.isNone(toolStarted) ||
        Option.isNone(toolCompleted) ||
        Option.isNone(content) ||
        Option.isNone(turnCompleted) ||
        Option.isNone(confirmed)
      )
        return;
      assert.equal(toolStarted.value.type, "item.started");
      assert.equal("itemType" in toolStarted.value.payload, true);
      if (!("itemType" in toolStarted.value.payload)) return;
      assert.equal(toolStarted.value.payload.itemType, "dynamic_tool_call");
      assert.equal(toolCompleted.value.type, "item.completed");
      assert.equal(content.value.type, "content.delta");
      assert.equal(turnCompleted.value.type, "turn.completed");
      assert.equal(confirmed.value.type, "content.delta");
      assert.equal("delta" in confirmed.value.payload, true);
      if (!("delta" in confirmed.value.payload)) return;
      assert.equal(confirmed.value.payload.delta, "confirmed");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
