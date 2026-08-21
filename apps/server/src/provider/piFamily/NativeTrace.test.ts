import { assert, describe, it } from "vite-plus/test";

import {
  BoundedNativeTraceRecorder,
  NATIVE_TRACE_NORMALIZATION_VERSION,
  NATIVE_TRACE_SCHEMA_VERSION,
  NativeTraceFixtureValidationError,
  NativeTraceRedactionError,
  NativeTraceRecorderLimitError,
  createNativeTraceFixture,
  redactNativeTrace,
  scanNativeTraceLeaks,
  normalizeNativeTrace,
  sha256NativeTraceValue,
  validateNativeTraceCorpus,
  validateNativeTraceFixture,
  type NativeTraceCapture,
} from "./NativeTrace.ts";

const encoder = new TextEncoder();

function collectNativeTraceKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectNativeTraceKeys(entry, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectNativeTraceKeys(child, keys);
  }
  return keys;
}

function syntheticCapture(): NativeTraceCapture {
  const recorder = new BoundedNativeTraceRecorder({
    maxBytes: 64,
    maxEvents: 8,
    maxDurationMs: 1000,
    nowMs: () => 0,
  });
  recorder.recordBytes("stdin", encoder.encode("synthetic input"));
  recorder.recordBytes("stdout", encoder.encode("synthetic output"));
  recorder.recordBytes("stderr", encoder.encode("synthetic diagnostic"));
  recorder.recordExit(0, null);
  return recorder.toEnvelope().capture;
}

function syntheticFixture(
  id = "synthetic-native-1",
  capture = syntheticCapture(),
): ReturnType<typeof createNativeTraceFixture> {
  const fixture = { id, label: "synthetic non-native trace", synthetic: true };
  const provenance = {
    source: "synthetic-test-data",
    sourceSha256: sha256NativeTraceValue("synthetic-source"),
  };
  const runtime = {
    kind: "pi",
    version: "synthetic-runtime",
    revision: "synthetic-revision",
  };
  const protocol = { name: "synthetic-jsonl", version: "1" };
  const capabilities = { stderr: true, chunks: true };
  const normalization = {
    version: NATIVE_TRACE_NORMALIZATION_VERSION,
    strategy: "deterministic-structural-v1",
  };
  const expectedOutcome = { status: "synthetic-complete", events: capture.totalEvents };
  const compatibility = {
    minSchemaVersion: NATIVE_TRACE_SCHEMA_VERSION,
    maxSchemaVersion: NATIVE_TRACE_SCHEMA_VERSION,
    runtimes: [runtime.kind],
  };
  const subject = {
    fixture,
    provenance,
    runtime,
    protocol,
    capabilities,
    capture,
    normalization,
    expectedOutcome,
    compatibility,
  };
  const redaction = redactNativeTrace(subject, {
    reviewed: true,
    allowedKeys: [...collectNativeTraceKeys(subject)],
  });
  const redactedSubject = redaction.value as typeof subject;
  return createNativeTraceFixture({
    fixture: redactedSubject.fixture,
    provenance: redactedSubject.provenance,
    runtime: redactedSubject.runtime,
    protocol: redactedSubject.protocol,
    capabilities: redactedSubject.capabilities,
    capture: redactedSubject.capture,
    normalization: redactedSubject.normalization,
    redaction: {
      version: redaction.report.version,
      reviewed: redaction.report.reviewed,
      leakScanPassed: redaction.report.leakScanPassed,
      reportHash: redaction.report.reportHash,
      unknownPaths: redaction.report.unknownPaths,
      report: redaction.report,
    },
    expectedOutcome: { value: redactedSubject.expectedOutcome },
    compatibility: redactedSubject.compatibility,
  });
}

function expectFixtureError(action: () => unknown, fragment: string): void {
  try {
    action();
  } catch (error) {
    assert.equal(error instanceof NativeTraceFixtureValidationError, true);
    if (error instanceof NativeTraceFixtureValidationError) assert.include(error.message, fragment);
    return;
  }
  throw new Error(`Expected fixture validation error containing ${fragment}`);
}
describe("NativeTrace", () => {
  it("records exact synthetic bytes with global event sequence and exit", () => {
    const recorder = new BoundedNativeTraceRecorder({
      maxBytes: 64,
      maxEvents: 4,
      maxDurationMs: 100,
      nowMs: () => 0,
    });
    recorder.recordBytes("stdin", new Uint8Array([0, 255, 4]));
    recorder.recordBytes("stdout", new Uint8Array([8, 9]));
    recorder.recordExit(null, "SIGTERM");
    recorder.finalize();
    assert.throws(() => recorder.recordBytes("stderr", new Uint8Array([1])));

    const capture = recorder.snapshot().capture;
    assert.deepEqual(capture.chunks, [
      { sequence: 0, stream: "stdin", byteLength: 3, bytesBase64: "AP8E" },
      { sequence: 1, stream: "stdout", byteLength: 2, bytesBase64: "CAk=" },
    ]);
    assert.deepEqual(capture.exits, [{ sequence: 2, code: null, signal: "SIGTERM" }]);
    assert.equal(capture.totalBytes, 5);
    assert.equal(capture.totalEvents, 3);
    assert.equal(capture.truncated, false);
  });

  it("marks byte, event, and injected-clock time limits and fails closed", () => {
    const byteLimited = new BoundedNativeTraceRecorder({
      maxBytes: 2,
      maxEvents: 4,
      maxDurationMs: 100,
      nowMs: () => 0,
    });
    assert.throws(
      () => byteLimited.recordBytes("stdout", new Uint8Array([1, 2, 3])),
      NativeTraceRecorderLimitError,
    );
    assert.equal(byteLimited.snapshot().capture.truncationReason, "byte-limit");
    assert.throws(
      () => byteLimited.recordBytes("stdout", new Uint8Array([1])),
      NativeTraceRecorderLimitError,
    );

    const eventLimited = new BoundedNativeTraceRecorder({
      maxBytes: 20,
      maxEvents: 1,
      maxDurationMs: 100,
      nowMs: () => 0,
    });
    eventLimited.recordBytes("stdout", new Uint8Array([1]));
    assert.throws(() => eventLimited.recordExit(0, null), NativeTraceRecorderLimitError);
    assert.equal(eventLimited.snapshot().capture.truncationReason, "event-limit");

    let now = 0;
    const timeLimited = new BoundedNativeTraceRecorder({
      maxBytes: 20,
      maxEvents: 4,
      maxDurationMs: 5,
      nowMs: () => now,
    });
    now = 6;
    assert.equal(timeLimited.snapshot().capture.truncationReason, "time-limit");
    assert.throws(() => timeLimited.finalize(), NativeTraceRecorderLimitError);
    assert.throws(
      () => timeLimited.recordBytes("stderr", new Uint8Array([1])),
      NativeTraceRecorderLimitError,
    );

    let finalizedNow = 0;
    const finalized = new BoundedNativeTraceRecorder({
      maxDurationMs: 5,
      nowMs: () => finalizedNow,
    });
    finalized.recordExit(0, null);
    finalized.finalize();
    finalizedNow = 6;
    assert.equal(finalized.snapshot().capture.truncated, false);

    const incomplete = new BoundedNativeTraceRecorder({ nowMs: () => 0 });
    incomplete.invalidate();
    assert.throws(() => incomplete.finalize(), NativeTraceRecorderLimitError);
    assert.equal(incomplete.snapshot().capture.truncationReason, "lifecycle-error");
  });

  it("normalizes deterministically, preserves identity relationships, and is idempotent", () => {
    const input = {
      taskId: "native-task-a",
      requestId: "native-request-a",
      id: "native-request-a",
      parentTaskId: "native-task-a",
      eventId: "native-event-a",
      filePath: "/synthetic/temp/a/file.ts",
      agentDirectory: "/synthetic/agent",
      startedAt: 1720000000,
      cwd: "/synthetic/temp/a",
      nested: { taskId: "native-task-a", usage: { inputTokens: 41 } },
    };
    const first = normalizeNativeTrace(input);
    const second = normalizeNativeTrace(input);
    assert.deepEqual(first, second);
    assert.deepEqual(normalizeNativeTrace(first), first);
    // normalizeNativeTrace deliberately returns unknown for arbitrary fixture payloads.
    const normalized = first as {
      readonly taskId: string;
      readonly id: string;
      readonly requestId: string;
      readonly parentTaskId: string;
      readonly eventId: string;
      readonly filePath: string;
      readonly agentDirectory: string;
      readonly startedAt: string;
      readonly nested: { readonly taskId: string };
    };
    assert.equal(normalized.taskId, normalized.nested.taskId);
    assert.equal(normalized.taskId, normalized.parentTaskId);
    assert.equal(normalized.id, normalized.requestId);
    assert.match(normalized.eventId, /^\[normalized:event:/u);
    assert.match(normalized.filePath, /^\[normalized:path:/u);
    assert.match(normalized.agentDirectory, /^\[normalized:path:/u);
    assert.equal(normalized.startedAt, "[normalized:time]");
  });

  it("redacts by allowlist with stable output, optional byte preservation, and leak scanning", () => {
    const first = redactNativeTrace(
      { type: "synthetic_event", message: "invented secret", status: "ok" },
      { reviewed: true },
    );
    const second = redactNativeTrace(first.value, { reviewed: true });
    assert.deepEqual(second.value, first.value);
    assert.deepEqual(scanNativeTraceLeaks(first.value), []);

    const preserved = redactNativeTrace(
      { message: "secret" },
      { preserveByteLength: true, reviewed: true },
    );
    const preservedValue = preserved.value;
    if (
      typeof preservedValue !== "object" ||
      preservedValue === null ||
      !("message" in preservedValue) ||
      typeof preservedValue.message !== "string"
    ) {
      throw new TypeError("Expected a redacted message");
    }
    assert.equal(
      encoder.encode(preservedValue.message).byteLength,
      encoder.encode("secret").byteLength,
    );
    assert.throws(() => redactNativeTrace({ unsafeField: "invented value" }, { reviewed: true }));
    for (const value of [
      "Bearer synthetic-secret",
      "AKIA1234567890ABCDEF",
      `AIza${"A".repeat(35)}`,
      "git@example.test:private/repository.git",
      "/private/var/folders/secret/capture.jsonl",
      "https://user:password@example.test/private.git",
    ]) {
      assert.isAbove(scanNativeTraceLeaks({ status: value }).length, 0, value);
    }
  });

  it("requires the reviewed redaction report to cover the complete fixture subject", () => {
    const capture = syntheticCapture();
    const unrelated = redactNativeTrace({ status: "synthetic-complete" }, { reviewed: true });
    assert.throws(
      () =>
        createNativeTraceFixture({
          fixture: {
            id: "synthetic-unbound-redaction",
            label: "synthetic unbound report",
            synthetic: true,
          },
          provenance: {
            source: "synthetic-test-data",
            sourceSha256: sha256NativeTraceValue("synthetic-source"),
          },
          runtime: { kind: "pi", version: "synthetic-runtime", revision: "synthetic-revision" },
          protocol: { name: "synthetic-jsonl", version: "1" },
          capabilities: { stderr: true },
          capture,
          redaction: {
            version: unrelated.report.version,
            reviewed: unrelated.report.reviewed,
            leakScanPassed: unrelated.report.leakScanPassed,
            reportHash: unrelated.report.reportHash,
            unknownPaths: unrelated.report.unknownPaths,
            report: unrelated.report,
          },
          expectedOutcome: { value: { status: "synthetic-complete" } },
        }),
      NativeTraceRedactionError,
    );
  });

  it("rejects sensitive patterns that remain in captured native bytes", () => {
    const recorder = new BoundedNativeTraceRecorder({
      maxBytes: 128,
      maxEvents: 2,
      maxDurationMs: 1000,
      nowMs: () => 0,
    });
    recorder.recordBytes("stdout", encoder.encode("Bearer synthetic-secret"));
    recorder.recordExit(0, null);
    assert.throws(
      () => syntheticFixture("synthetic-native-leak", recorder.capture().capture),
      NativeTraceRedactionError,
    );
  });

  it("validates synthetic provenance, hashes, lengths, schemas, and expected output", () => {
    const fixture = syntheticFixture();
    assert.equal(validateNativeTraceFixture(fixture).manifest?.fixture?.synthetic, true);

    const wrongChunkHash = {
      ...fixture,
      manifest: {
        ...fixture.manifest!,
        capture: { ...fixture.manifest!.capture, byteSha256: "0".repeat(64) },
      },
    };
    expectFixtureError(() => validateNativeTraceFixture(wrongChunkHash), "byteSha256");

    const wrongLength = {
      ...fixture,
      capture: {
        ...fixture.capture,
        chunks: [
          { ...fixture.capture.chunks[0]!, byteLength: 99 },
          ...fixture.capture.chunks.slice(1),
        ],
      },
    };
    expectFixtureError(() => validateNativeTraceFixture(wrongLength), "byteLength");

    const outOfOrder = {
      ...fixture,
      capture: {
        ...fixture.capture,
        chunks: [
          fixture.capture.chunks[1]!,
          fixture.capture.chunks[0]!,
          ...fixture.capture.chunks.slice(2),
        ],
      },
    };
    expectFixtureError(
      () => validateNativeTraceFixture(outOfOrder),
      "non-canonical sequence order",
    );

    expectFixtureError(
      () =>
        validateNativeTraceFixture({ ...fixture, schemaVersion: NATIVE_TRACE_SCHEMA_VERSION + 1 }),
      "unsupported schema",
    );
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: { ...fixture.manifest!, provenance: undefined },
        }),
      "missing",
    );
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: {
            ...fixture.manifest!,
            redaction: { ...fixture.manifest!.redaction, reviewed: false },
          },
        }),
      "unreviewed",
    );
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: {
            ...fixture.manifest!,
            expectedOutcome: { ...fixture.manifest!.expectedOutcome, sha256: "f".repeat(64) },
          },
        }),
      "expectedOutcome.sha256",
    );
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: {
            ...fixture.manifest!,
            expectedOutcome: {
              ...fixture.manifest!.expectedOutcome,
              fixtureId: "different-fixture",
            },
          },
        }),
      "fixtureId: mismatch",
    );
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: {
            ...fixture.manifest!,
            expectedOutcome: {
              ...fixture.manifest!.expectedOutcome,
              value: { status: "Bearer synthetic-secret" },
              sha256: sha256NativeTraceValue({ status: "Bearer synthetic-secret" }),
            },
          },
        }),
      "sensitive subject patterns",
    );
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: {
            ...fixture.manifest!,
            capabilities: {
              ...fixture.manifest!.capabilities,
              info: "Bearer synthetic-secret",
            },
          },
        }),
      "sensitive subject patterns",
    );

    const { reportHash: _reportHash, ...unsafeReportWithoutHash } = {
      ...fixture.manifest!.redaction.report,
      redactedPaths: ["Bearer synthetic-secret"],
    };
    const unsafeReportHash = sha256NativeTraceValue(unsafeReportWithoutHash);
    const unsafeReport = { ...unsafeReportWithoutHash, reportHash: unsafeReportHash };
    expectFixtureError(
      () =>
        validateNativeTraceFixture({
          ...fixture,
          manifest: {
            ...fixture.manifest!,
            redaction: {
              ...fixture.manifest!.redaction,
              reportHash: unsafeReportHash,
              report: unsafeReport,
            },
          },
        }),
      "sensitive report metadata",
    );

    const missingExit = {
      ...fixture,
      capture: {
        ...fixture.capture,
        exits: [],
        totalEvents: fixture.capture.totalEvents - 1,
      },
      manifest: {
        ...fixture.manifest!,
        capture: {
          ...fixture.manifest!.capture,
          exits: [],
          totalEvents: fixture.manifest!.capture.totalEvents - 1,
        },
      },
    };
    expectFixtureError(
      () => validateNativeTraceFixture(missingExit),
      "exits: required exactly one",
    );

    const terminalSequence = fixture.capture.totalEvents - 1;
    const previousSequence = terminalSequence - 1;
    const nonterminalExit = {
      ...fixture,
      capture: {
        ...fixture.capture,
        chunks: fixture.capture.chunks.map((chunk) =>
          chunk.sequence === previousSequence ? { ...chunk, sequence: terminalSequence } : chunk,
        ),
        exits: fixture.capture.exits.map((exit) => ({
          ...exit,
          sequence: previousSequence,
        })),
      },
      manifest: {
        ...fixture.manifest!,
        capture: {
          ...fixture.manifest!.capture,
          chunks: fixture.manifest!.capture.chunks.map((chunk) =>
            chunk.sequence === previousSequence ? { ...chunk, sequence: terminalSequence } : chunk,
          ),
          exits: fixture.manifest!.capture.exits.map((exit) => ({
            ...exit,
            sequence: previousSequence,
          })),
        },
      },
    };
    expectFixtureError(
      () => validateNativeTraceFixture(nonterminalExit),
      "exit must be the terminal event",
    );
  });

  it("rejects duplicate corpus IDs and inconsistent sequences", () => {
    const fixture = syntheticFixture();
    expectFixtureError(
      () => validateNativeTraceCorpus([fixture, syntheticFixture()]),
      "duplicate fixture ID",
    );
    const badSequence = {
      ...fixture,
      capture: {
        ...fixture.capture,
        chunks: [
          { ...fixture.capture.chunks[0]!, sequence: 9 },
          ...fixture.capture.chunks.slice(1),
        ],
      },
    };
    expectFixtureError(
      () => validateNativeTraceFixture(badSequence),
      "inconsistent chunk sequences",
    );
  });
});
