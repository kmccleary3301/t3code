import { assert, describe, it } from "vite-plus/test";

import {
  OmpChunkAssembler,
  type JsonRecord,
  type NativeTaskSnapshot,
  type RpcEnvelope,
  type PiFamilyProjectedEvent,
  type PiFamilyRuntimeKind,
  parseJsonObject,
} from "./index.ts";
import { nativeEventId, PiFamilyEventProjector } from "./PiFamilyEventProjector.ts";
import { scanNativeTraceLeaks, sha256NativeTraceValue } from "./NativeTrace.ts";
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
import ompCanonicalOracleJson from "./testFixtures/native/omp-edge-canonical-oracle.json" with { type: "json" };
import piCanonicalOracleJson from "./testFixtures/native/pi-edge-canonical-oracle.json" with { type: "json" };
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";

interface ReplayResult {
  readonly events: readonly RpcEnvelope[];
  readonly projected: readonly PiFamilyProjectedEvent[];
  readonly identities: readonly string[];
  readonly projector: PiFamilyEventProjector;
}

interface CanonicalOracle {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly sourceTrace: string;
  readonly sourceSha256: string;
  readonly runtime: PiFamilyRuntimeKind;
  readonly authorship: "hand-authored";
  readonly events: readonly JsonRecord[];
  readonly identities: readonly string[];
  readonly tasks: readonly NativeTaskSnapshot[];
  readonly unknownEvents: readonly RpcEnvelope[];
  readonly diagnostics: {
    readonly retainedUnknownEvents: number;
    readonly droppedUnknownEvents: number;
    readonly taskSnapshots: number;
    readonly activeTasks: number;
  };
  readonly state: {
    readonly turn: "active" | "settled";
    readonly retainedUnknownEvents: number;
    readonly activeTasks: number;
  };
  readonly checkpoints: readonly JsonRecord[];
  readonly invariants: {
    readonly sourceEventCount: number;
    readonly projectedEventCount: number;
    readonly uniqueIdentityCount: number;
    readonly terminalEventKind: string;
  };
}

const piCanonicalOracle = piCanonicalOracleJson as CanonicalOracle;
const ompCanonicalOracle = ompCanonicalOracleJson as CanonicalOracle;

function canonicalEvent(event: PiFamilyProjectedEvent): JsonRecord {
  const normalized = { ...event } as JsonRecord;
  delete normalized.raw;
  return normalized;
}

function assertCanonicalOracle(
  replay: ReplayResult,
  oracle: CanonicalOracle,
  sourceTrace: readonly JsonRecord[],
): void {
  assert.equal(oracle.schemaVersion, 1);
  assert.equal(oracle.authorship, "hand-authored");
  assert.match(oracle.fixtureId, new RegExp(`^${oracle.runtime}-`));
  assert.equal(oracle.sourceTrace, oracle.runtime === "pi" ? "piNativeTrace" : "ompNativeTrace");
  assert.isTrue(oracle.identities.every((identity) => identity.startsWith(`${oracle.runtime}:`)));
  assert.deepEqual(scanNativeTraceLeaks(oracle), []);
  assert.isAtMost(new TextEncoder().encode(JSON.stringify(oracle)).byteLength, 64 * 1024);
  assert.deepEqual(replay.projected.map(canonicalEvent), oracle.events);
  assert.equal(sha256NativeTraceValue(sourceTrace), oracle.sourceSha256);
  for (const event of replay.projected) {
    if ("raw" in event && event.raw !== undefined) {
      assert.isTrue(replay.events.some((source) => source === event.raw));
    }
  }
  assert.deepEqual(replay.identities, oracle.identities);
  assert.deepEqual(oracle.tasks, replay.projector.snapshotTasks());
  assert.deepEqual(oracle.unknownEvents, replay.projector.snapshotUnknownEvents());
  const diagnostics = replay.projector.diagnostics();
  assert.deepEqual(diagnostics, oracle.diagnostics);
  const terminalEventKind = replay.projected.at(-1)?.kind ?? "";
  assert.deepEqual(
    {
      turn: terminalEventKind === "turn.settled" ? "settled" : "active",
      retainedUnknownEvents: diagnostics.retainedUnknownEvents,
      activeTasks: diagnostics.activeTasks,
    },
    oracle.state,
  );
  assert.deepEqual(oracle.checkpoints, []);
  assert.deepEqual(
    {
      sourceEventCount: replay.events.length,
      projectedEventCount: replay.projected.length,
      uniqueIdentityCount: new Set(replay.identities).size,
      terminalEventKind,
    },
    oracle.invariants,
  );
}

function replayTrace(trace: string, runtime: PiFamilyRuntimeKind, chunked: boolean): ReplayResult {
  const decoder = new StrictJsonlDecoder(64 * 1024);
  const assembler = chunked ? new OmpChunkAssembler() : undefined;
  const events: RpcEnvelope[] = [];
  const projected: PiFamilyProjectedEvent[] = [];
  const identities: string[] = [];
  const projector = new PiFamilyEventProjector(runtime);
  const identityOccurrences = new Map<string, number>();

  const project = (event: RpcEnvelope): void => {
    events.push(event);
    const baseIdentity = nativeEventId(runtime, event);
    const occurrence = identityOccurrences.get(baseIdentity) ?? 0;
    identityOccurrences.set(baseIdentity, occurrence + 1);
    identities.push(nativeEventId(runtime, event, occurrence));
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
    const settled = replay.projected.filter((event) => event.kind === "turn.settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.raw.type, "agent_settled");
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
    assertCanonicalOracle(first, piCanonicalOracle, piNativeTrace);
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
    assertCanonicalOracle(first, ompCanonicalOracle, ompNativeTrace);
    assert.equal(first.events.length, ompNativeTrace.length);
    assert.equal(first.projector.diagnostics().activeTasks, 0);
  });
});
