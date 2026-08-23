#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";
import { performance } from "node:perf_hooks";

import {
  OmpChunkAssembler,
  PiFamilyEventProjector,
  StrictJsonlDecoder,
  nativeEventId,
  parseJsonObject,
} from "../apps/server/src/provider/piFamily/index.ts";
import {
  ompNativeChunkedTraceJsonl,
  ompNativeTrace,
  piNativeTrace,
  piNativeTraceJsonl,
} from "../apps/server/src/provider/piFamily/nativeTraceFixtures.ts";

const iterations = 5;
const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const timed = <A>(operation: () => A): { readonly value: A; readonly milliseconds: number } => {
  const start = performance.now();
  const value = operation();
  return { value, milliseconds: performance.now() - start };
};

const replay = (trace: string, runtime: "pi" | "omp", chunked: boolean) => {
  const decoder = new StrictJsonlDecoder(64 * 1024);
  const assembler = chunked ? new OmpChunkAssembler() : undefined;
  const projector = new PiFamilyEventProjector(runtime);
  const identities = new Set<string>();
  let occurrence = 0;
  let events = 0;
  const consume = (line: string): void => {
    const frame = parseJsonObject(line);
    const event = assembler?.accept(frame) ?? frame;
    if (event === undefined) return;
    events += 1;
    identities.add(nativeEventId(runtime, event, occurrence));
    occurrence += 1;
    projector.project(event);
  };
  const bytes = new TextEncoder().encode(trace);
  for (let offset = 0; offset < bytes.byteLength; offset += 97) {
    for (const line of decoder.push(
      bytes.subarray(offset, Math.min(offset + 97, bytes.byteLength)),
    )) {
      consume(line);
    }
  }
  for (const line of decoder.finish()) consume(line);
  if (assembler !== undefined && assembler.pendingMessageCount !== 0) {
    throw new Error("OMP fixture left an incomplete chunk");
  }
  return { events, projected: projector.snapshotTasks().length, identities: identities.size };
};

const measureReplay = (trace: string, runtime: "pi" | "omp", chunked: boolean) => {
  const samples: number[] = [];
  let result = { events: 0, projected: 0, identities: 0 };
  for (let index = 0; index < iterations; index += 1) {
    const measured = timed(() => replay(trace, runtime, chunked));
    samples.push(measured.milliseconds);
    result = measured.value;
  }
  return {
    fixtureBytes: Buffer.byteLength(trace),
    iterations,
    medianMilliseconds: Number(median(samples).toFixed(3)),
    events: result.events,
    projectedTasks: result.projected,
    uniqueIdentities: result.identities,
  };
};

const measureSnapshot = () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-performance-baseline-"));
  const sourcePath = NodePath.join(tempDir, "source.sqlite");
  const snapshotPath = NodePath.join(tempDir, "snapshot.sqlite");
  const db = new NodeSqlite.DatabaseSync(sourcePath);
  try {
    db.exec("CREATE TABLE events(sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO events(sequence, payload) VALUES (?, ?)");
    for (let index = 0; index < 250; index += 1) insert.run(index, "[redacted]");
    const measured = timed(() => db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`));
    return {
      sourceRows: 250,
      snapshotBytes: NodeFS.statSync(snapshotPath).size,
      milliseconds: Number(measured.milliseconds.toFixed(3)),
    };
  } finally {
    db.close();
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
};

const measureWebSocketPayload = () => {
  const payload = Buffer.from(JSON.stringify({ runtime: "pi", events: piNativeTrace }));
  const samples: number[] = [];
  let compressedBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const measured = timed(() => NodeZlib.deflateRawSync(payload));
    samples.push(measured.milliseconds);
    compressedBytes = measured.value.byteLength;
  }
  return {
    inputBytes: payload.byteLength,
    compressedBytes,
    iterations,
    medianMilliseconds: Number(median(samples).toFixed(3)),
  };
};

const report = {
  schemaVersion: 1,
  node: process.version,
  generatedAt: new Date().toISOString(),
  fixtureLoad: {
    piBytes: Buffer.byteLength(piNativeTraceJsonl),
    ompBytes: Buffer.byteLength(ompNativeChunkedTraceJsonl),
    piRecords: piNativeTrace.length,
  },
  decodeReplayProjection: {
    pi: measureReplay(piNativeTraceJsonl, "pi", false),
    omp: measureReplay(ompNativeChunkedTraceJsonl, "omp", true),
  },
  snapshot: measureSnapshot(),
  websocketCompression: measureWebSocketPayload(),
  memory: process.memoryUsage(),
  note: "Run beside the focused transfer-budget report; compare like-for-like Node/runtime and fixture revisions before adding thresholds.",
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
