import { assert, describe, it } from "vite-plus/test";

import {
  OmpChunkAssembler,
  type JsonRecord,
  type RpcEnvelope,
  type PiFamilyProjectedEvent,
  type PiFamilyRuntimeKind,
  parseJsonObject,
} from "./index.ts";
import { nativeEventId, PiFamilyEventProjector } from "./PiFamilyEventProjector.ts";
import {
  nativeTraceProvenance,
  ompNativeChunkedTraceJsonl,
  ompNativeTrace,
  ompRecordedNativeChunkedTraceJsonl,
  ompRecordedNativeTrace,
  piNativeTrace,
  piNativeTraceJsonl,
  piRecordedNativeTrace,
  piRecordedNativeTraceJsonl,
} from "./nativeTraceFixtures.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";

interface ReplayResult {
  readonly events: readonly RpcEnvelope[];
  readonly projected: readonly PiFamilyProjectedEvent[];
  readonly identities: readonly string[];
  readonly projector: PiFamilyEventProjector;
}

function replayTrace(trace: string, runtime: PiFamilyRuntimeKind, chunked: boolean): ReplayResult {
  const decoder = new StrictJsonlDecoder(64 * 1024);
  const assembler = chunked ? new OmpChunkAssembler() : undefined;
  const events: RpcEnvelope[] = [];
  const projected: PiFamilyProjectedEvent[] = [];
  const identities: string[] = [];
  const projector = new PiFamilyEventProjector(runtime);

  const project = (event: RpcEnvelope): void => {
    events.push(event);
    identities.push(nativeEventId(runtime, event));
    projected.push(...projector.project(event));
  };
  const consumeLine = (line: string): void => {
    const record = parseJsonObject(line);
    if (assembler) {
      const event = assembler.accept(record);
      if (event) project(event);
    } else {
      project(record);
    }
  };

  const bytes = new TextEncoder().encode(trace);
  const chunkWidths = [1, 2, 5, 3, 8, 13, 21];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    const width = chunkWidths[chunkIndex % chunkWidths.length]!;
    const end = Math.min(bytes.byteLength, offset + width);
    for (const line of decoder.push(bytes.subarray(offset, end))) consumeLine(line);
    offset = end;
    chunkIndex += 1;
  }
  for (const line of decoder.finish()) consumeLine(line);
  if (assembler !== undefined && assembler.pendingMessageCount !== 0) {
    throw new Error("OMP replay ended with an incomplete rpc_chunk sequence");
  }

  return { events, projected, identities, projector };
}

const expectedKinds = [
  "turn.started",
  "message.delta",
  "message.delta",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "task.started",
  "task.started",
  "task.progress",
  "task.progress",
  "task.completed",
  "task.completed",
  "compaction.started",
  "compaction.completed",
  "retry.scheduled",
  "retry.scheduled",
  "runtime.raw",
  "message.completed",
  "turn.settled",
];

function assertReplayContract(
  first: ReplayResult,
  second: ReplayResult,
  expectedTrace: readonly JsonRecord[],
  expectedText: readonly string[],
  parentId: string,
  childId: string,
  requestId: string,
  unknownType: string,
): void {
  assert.deepEqual(
    first.projected.map((event) => event.kind),
    expectedKinds,
  );
  assert.equal(first.identities.length, expectedTrace.length);
  assert.equal(new Set(first.identities).size, expectedTrace.length);
  assert.deepEqual(first.identities, second.identities);
  assert.deepEqual(first.events, expectedTrace);
  assert.deepEqual(second.events, expectedTrace);

  const deltas = first.projected.filter(
    (event): event is Extract<PiFamilyProjectedEvent, { readonly kind: "message.delta" }> =>
      event.kind === "message.delta",
  );
  assert.deepEqual(
    deltas.map((event) => event.text),
    expectedText,
  );
  assert.equal(deltas.length, expectedText.length);

  const completed = first.projected.filter((event) => event.kind === "message.completed");
  assert.equal(completed.length, 1);
  assert.equal("text" in completed[0]!, false);
  assert.equal(first.projected[first.projected.length - 1]?.kind, "turn.settled");
  const settled = first.projected[first.projected.length - 1];
  if (settled?.kind === "turn.settled") assert.equal(settled.requestId, requestId);

  assert.deepEqual(first.projector.snapshotUnknownEvents(), [
    expectedTrace.find((event) => event.type === unknownType),
  ]);
  assert.equal(first.projector.diagnostics().activeTasks, 0);
  assert.deepEqual(
    first.projector.snapshotTasks().map((task) => ({
      id: task.id,
      status: task.status,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      ...(task.parentToolCallId === undefined ? {} : { parentToolCallId: task.parentToolCallId }),
    })),
    [
      { id: parentId, status: "completed" },
      {
        id: childId,
        status: "completed",
        parentTaskId: parentId,
        parentToolCallId: `${parentId === "pi-parent" ? "pi" : "omp"}-spawn`,
      },
    ],
  );
}

describe("Pi/OMP native trace replay", () => {
  it("replays the revision-bound scrubbed Pi capture through production framing", () => {
    const replay = replayTrace(piRecordedNativeTraceJsonl, "pi", false);
    assert.deepEqual(replay.events, piRecordedNativeTrace);
    assert.equal(new Set(replay.identities).size, piRecordedNativeTrace.length);
    const kinds = replay.projected.map((event) => event.kind);
    assert.include(kinds, "turn.started");
    assert.include(kinds, "message.completed");
    assert.include(kinds, "turn.settled");
    assert.match(nativeTraceProvenance.pi.runtimeRevision, /^[0-9a-f]{40}$/);
    assert.match(nativeTraceProvenance.pi.sourceSha256, /^[0-9a-f]{64}$/);
  });

  it("reassembles the revision-bound scrubbed OMP root/task captures", () => {
    const replay = replayTrace(ompRecordedNativeChunkedTraceJsonl, "omp", true);
    assert.deepEqual(replay.events, ompRecordedNativeTrace);
    assert.equal(new Set(replay.identities).size, ompRecordedNativeTrace.length);
    const kinds = replay.projected.map((event) => event.kind);
    assert.include(kinds, "ui.request");
    assert.include(kinds, "tool.started");
    assert.include(kinds, "task.started");
    assert.include(kinds, "task.completed");
    assert.include(kinds, "message.completed");
    assert.include(kinds, "turn.settled");
    assert.match(nativeTraceProvenance.omp.runtimeRevision, /^[0-9a-f]{40}$/);
    for (const hash of nativeTraceProvenance.omp.sourceSha256) {
      assert.match(hash, /^[0-9a-f]{64}$/);
    }
  });

  it("replays a scrubbed Pi JSONL trace through framing and canonical projection", () => {
    const first = replayTrace(piNativeTraceJsonl, "pi", false);
    const second = replayTrace(piNativeTraceJsonl, "pi", false);

    assertReplayContract(
      first,
      second,
      piNativeTrace,
      ["Hello ", "πi"],
      "pi-parent",
      "pi-child",
      "pi-request",
      "future_pi_event",
    );
  });

  it("reassembles and replays a scrubbed OMP chunked trace with its native dialect", () => {
    const first = replayTrace(ompNativeChunkedTraceJsonl, "omp", true);
    const second = replayTrace(ompNativeChunkedTraceJsonl, "omp", true);

    assertReplayContract(
      first,
      second,
      ompNativeTrace,
      ["Hello ", "OMP"],
      "omp-parent",
      "omp-child",
      "omp-request",
      "future_omp_event",
    );
    assert.equal(first.events.length, ompNativeTrace.length);
    assert.equal(first.projector.diagnostics().activeTasks, 0);
  });
});
