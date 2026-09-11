import { assert, describe, it } from "vite-plus/test";

import { PiFamilyEventProjector } from "./PiFamilyEventProjector.ts";
import {
  absentRuntimeCapabilities,
  formatPortableUiResponse,
  isRpcResponse,
  makeOmpNegotiateProtocolCommand,
  negotiatedRuntimeCapabilities,
  parseJsonObject,
  readRuntimeCapabilities,
  validateOmpNegotiateProtocolResponse,
  validateOmpReadyFrame,
} from "./protocol.ts";
import { PiFamilyRequestCorrelator } from "./RequestCorrelation.ts";

describe("Pi and OMP protocol contracts", () => {
  it("keeps Pi v1 and OMP v2 negotiation capabilities distinct", () => {
    const pi = absentRuntimeCapabilities("pi");
    const omp = absentRuntimeCapabilities("omp");
    assert.deepEqual(pi.supportedProtocolVersions, [1]);
    assert.strictEqual(pi.transport.chunking, false);
    assert.deepEqual(omp.supportedProtocolVersions, [1, 2]);
    assert.strictEqual(omp.transport.chunking, true);
    assert.strictEqual(pi.models.discover, false);
    assert.strictEqual(omp.tasks.lifecycle, false);
  });

  it("uses the stock RPC contract when capability discovery is absent", () => {
    const pi = negotiatedRuntimeCapabilities("pi");
    const ompBeforeNegotiation = negotiatedRuntimeCapabilities("omp");
    const omp = negotiatedRuntimeCapabilities("omp", 2);

    assert.strictEqual(pi.models.switch, true);
    assert.strictEqual(pi.sessions.fork, true);
    assert.strictEqual(pi.tasks.lifecycle, false);
    assert.strictEqual(ompBeforeNegotiation.models.switch, false);
    assert.strictEqual(omp.models.switch, true);
    assert.strictEqual(omp.sessions.compact, true);
    assert.strictEqual(omp.tasks.lifecycle, true);
    assert.strictEqual(omp.tasks.nested, false);
    assert.strictEqual(omp.tasks.childTranscript, true);
    assert.strictEqual(omp.tasks.background, false);
    assert.strictEqual(omp.tasks.targetedCancellation, false);
    assert.strictEqual(omp.ui.askDialog, false);
  });

  it("validates OMP ready and negotiate frames exactly", () => {
    const ready = validateOmpReadyFrame({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864,
    });
    assert.strictEqual(ready.protocolVersion, 1);
    const command = makeOmpNegotiateProtocolCommand("protocol-1");
    assert.deepEqual(command, {
      id: "protocol-1",
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
    const commandWithCaps = makeOmpNegotiateProtocolCommand("protocol-1", {
      ui: { askDialog: true },
    });
    assert.deepEqual(commandWithCaps, {
      id: "protocol-1",
      type: "negotiate_protocol",
      protocolVersion: 2,
      capabilities: { ui: { askDialog: true } },
    });
    const response = validateOmpNegotiateProtocolResponse({
      id: "protocol-1",
      type: "response",
      command: "negotiate_protocol",
      success: true,
      data: { protocolVersion: 2 },
    });
    assert.strictEqual(response.data.protocolVersion, 2);
    assert.throws(() => validateOmpReadyFrame({ ...ready, protocolVersion: 2 }));
    assert.throws(() =>
      validateOmpNegotiateProtocolResponse({ ...response, data: { protocolVersion: 1 } }),
    );
  });

  it("enables askDialog only when explicitly advertised in capabilities", () => {
    const withoutAskDialog = readRuntimeCapabilities("omp", {
      protocolVersion: 2,
      ui: { select: true, confirm: true },
    });
    assert.strictEqual(withoutAskDialog.ui.askDialog, false);

    const withAskDialog = readRuntimeCapabilities("omp", {
      protocolVersion: 2,
      ui: { select: true, confirm: true, askDialog: true },
    });
    assert.strictEqual(withAskDialog.ui.askDialog, true);
  });

  it("formats portable UI responses including answers and chat", () => {
    assert.deepEqual(formatPortableUiResponse({ requestId: "r1", cancelled: true }), {
      type: "extension_ui_response",
      id: "r1",
      cancelled: true,
    });
    assert.deepEqual(formatPortableUiResponse({ requestId: "r2", value: "hello" }), {
      type: "extension_ui_response",
      id: "r2",
      value: "hello",
    });
    assert.deepEqual(
      formatPortableUiResponse({
        requestId: "r3",
        answers: { auth: "JWT" },
        value: "JWT",
      }),
      {
        type: "extension_ui_response",
        id: "r3",
        value: "JWT",
        answers: { auth: "JWT" },
      },
    );
    assert.deepEqual(formatPortableUiResponse({ requestId: "r4", chat: true }), {
      type: "extension_ui_response",
      id: "r4",
      chat: true,
    });
  });

  it("retains unknown native events while projecting only the selected dialect", () => {
    const pi = new PiFamilyEventProjector("pi");
    const omp = new PiFamilyEventProjector("omp");
    const unknown = { type: "provider_future_event", nested: { value: "opaque" } };
    assert.deepEqual(pi.project(unknown), [{ kind: "runtime.raw", event: unknown }]);
    assert.deepEqual(omp.project(unknown), [{ kind: "runtime.raw", event: unknown }]);
    assert.deepEqual(
      pi.project({ type: "subagent_lifecycle", id: "child" })[0]?.kind,
      "runtime.raw",
    );
    assert.deepEqual(
      omp.project({ type: "subagent_lifecycle", id: "child", status: "running" })[0]?.kind,
      "task.started",
    );
  });

  it("correlates immediate and deferred responses without reusing IDs", () => {
    let now = 10;
    const tracker = new PiFamilyRequestCorrelator(() => now);
    const immediate = tracker.register({ id: "r1", runtime: "pi", command: "get_state" });
    const deferred = tracker.register({
      id: "r2",
      runtime: "pi",
      command: "prompt",
      responseMode: "deferred",
    });
    assert.strictEqual(immediate.responseMode, "immediate");
    assert.strictEqual(deferred.responseMode, "deferred");
    assert.throws(() => tracker.register({ id: "r1", runtime: "pi", command: "prompt" }));

    tracker.markSent("r1");
    now = 20;
    const success = tracker.resolve({
      id: "r1",
      type: "response",
      command: "get_state",
      success: true,
    });
    assert.strictEqual(success.matched, true);
    if (success.matched) assert.strictEqual(success.record.state, "succeeded");

    tracker.markSent("r2");
    const failure = tracker.resolve({
      id: "r2",
      type: "response",
      command: "prompt",
      success: false,
      error: "provider rejected prompt",
    });
    assert.strictEqual(failure.matched, true);
    if (failure.matched) {
      assert.strictEqual(failure.record.state, "failed");
      assert.strictEqual(failure.record.failure?.kind, "provider");
      assert.strictEqual(failure.record.failure?.message, "provider rejected prompt");
    }
  });

  it("classifies request timeouts and ignores late responses", () => {
    let now = 10;
    const tracker = new PiFamilyRequestCorrelator(() => now);
    tracker.register({ id: "late", runtime: "omp", command: "prompt", responseMode: "deferred" });
    tracker.markSent("late");
    now = 30;
    const timedOut = tracker.timeout("late", "request", "prompt response deadline exceeded");
    assert.strictEqual(timedOut.state, "timed_out");
    assert.strictEqual(timedOut.failure?.kind, "timeout");
    assert.strictEqual(timedOut.failure?.timeoutClass, "request");
    assert.strictEqual(timedOut.failure?.message, "prompt response deadline exceeded");
    const late = tracker.resolve({
      id: "late",
      type: "response",
      command: "prompt",
      success: true,
    });
    assert.strictEqual(late.matched, false);
    assert.strictEqual(tracker.get("late")?.state, "timed_out");
  });

  it("separates child crash failure from clean shutdown", () => {
    const crashed = new PiFamilyRequestCorrelator(() => 10);
    crashed.register({ id: "crash", runtime: "pi", command: "prompt" });
    crashed.markSent("crash");
    const crashRecords = crashed.failAll({
      kind: "transport",
      message: "child exited with code 137",
    });
    assert.strictEqual(crashRecords[0]?.state, "failed");
    assert.strictEqual(crashRecords[0]?.failure?.kind, "transport");
    assert.strictEqual(
      crashed.resolve({ id: "crash", type: "response", command: "prompt", success: true }).matched,
      false,
    );

    const closed = new PiFamilyRequestCorrelator(() => 20);
    closed.register({ id: "close", runtime: "omp", command: "get_state" });
    closed.markSent("close");
    const closedRecords = closed.close("session stopped cleanly");
    assert.strictEqual(closedRecords[0]?.state, "closed");
    assert.strictEqual(closedRecords[0]?.failure?.kind, "closed");
    assert.strictEqual(
      closed.resolve({ id: "close", type: "response", command: "get_state", success: true })
        .matched,
      false,
    );
  });

  it("returns unmatched responses without IDs", () => {
    const tracker = new PiFamilyRequestCorrelator();
    const response = { type: "response", command: "prompt", success: true } as const;
    const result = tracker.resolve(response);
    assert.strictEqual(result.matched, false);
    if (!result.matched) assert.deepEqual(result.response, response);
  });

  it("parses object frames and rejects non-response objects as responses", () => {
    const frame = parseJsonObject('{"type":"message_end","text":"ok"}');
    assert.strictEqual(frame.type, "message_end");
    assert.strictEqual(isRpcResponse(frame), false);
    assert.throws(() => parseJsonObject("[]"));
  });
});
