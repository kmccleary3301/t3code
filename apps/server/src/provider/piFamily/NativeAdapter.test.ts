import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makePiFamilyAdapter } from "./NativeAdapter.ts";

type Runtime = "pi" | "omp";

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
          '  if (command.type === "checkpoint") out({ id: command.id, type: "response", command: "checkpoint", success: true, data: { goal: command.goal, startedAt: "2026-01-01T00:00:00.000Z" } });',
          '  if (command.type === "rewind") out({ id: command.id, type: "response", command: "rewind", success: true, data: { report: command.report, rewound: true } });',
        ]
      : [
          '  if (command.type === "capture_checkpoint") out({ id: command.id, type: "response", command: "capture_checkpoint", success: true, data: { runtime: "pi", sessionId: "test-session", leafEntryId: "leaf-1" } });',
          '  if (command.type === "restore_checkpoint") out({ id: command.id, type: "response", command: "restore_checkpoint", success: true });',
        ]),
    '  if (command.type === "extension_ui_response" && command.id === "approval-1" && command.confirmed === true) out({ type: "message_update", delta: { text: "confirmed" } });',
    '  if (command.type === "prompt") {',
    '    out({ id: command.id, type: "response", command: "prompt", success: true });',
    ...(malformed
      ? [
          '    if (command.message === "malformed") {',
          '      process.stdout.write("{not-json\\n");',
          '      process.stdout.write("{still-not-json\\n");',
          '      out({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "Approve", message: "Proceed?" });',
          '      out({ type: "tool_execution_start", toolName: "subagent", id: "tool-1" });',
          '      out({ type: "tool_execution_end", toolName: "subagent", id: "tool-1" });',
          '      out({ type: "message_update", delta: { text: "after malformed" } });',
          '      out({ type: "turn_end", id: command.id });',
          "      return;",
          "    }",
        ]
      : []),
    '    out({ type: "turn_start", id: command.id });',
    '    out({ type: "message_update", delta: { text: "hello from native" } });',
    '    out({ type: "message_end", message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "hello from native" }], stopReason: "stop" } });',
    '    out({ type: "turn_end", id: command.id });',
    "  }",
    '  if (command.type === "abort") out({ id: command.id, type: "response", command: "abort", success: true });',
    "});",
  );
  return lines.join("\n");
};

const nextEvent = (stream: Stream.Stream<ProviderRuntimeEvent>) =>
  Stream.runHead(stream).pipe(Effect.timeout("2 seconds"));

describe("Pi-family native adapter", () => {
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

        yield* adapter.stopSession(threadId);
        assert.equal(yield* adapter.hasSession(threadId), false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
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
