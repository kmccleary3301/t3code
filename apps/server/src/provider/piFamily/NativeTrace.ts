import * as NodeCrypto from "node:crypto";
import * as NodePerfHooks from "node:perf_hooks";

/** The capture envelope is deliberately independent of provider orchestration. */
export const NATIVE_TRACE_SCHEMA_VERSION = 1 as const;
export const NATIVE_TRACE_NORMALIZATION_VERSION = 1 as const;
export const NATIVE_TRACE_REDACTION_VERSION = 2 as const;

export type NativeTraceStream = "stdin" | "stdout" | "stderr";
export type NativeTraceRuntimeKind = "pi" | "omp" | (string & {});

export interface NativeTraceSink {
  recordBytes(stream: NativeTraceStream, bytes: Uint8Array): void;
  recordExit(code: number | null, signal: string | null): void;
  invalidate(): void;
  finalize?(): void;
}

export interface NativeTraceSessionIdentity {
  readonly threadId: string;
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly runtime: NativeTraceRuntimeKind;
}

export interface NativeTraceSinkFactory {
  create(identity: NativeTraceSessionIdentity): NativeTraceSink;
}

export interface NativeTraceChunk {
  readonly sequence: number;
  readonly stream: NativeTraceStream;
  readonly byteLength: number;
  readonly bytesBase64: string;
}

export interface NativeTraceExit {
  readonly sequence: number;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface NativeTraceCapture {
  readonly chunks: readonly NativeTraceChunk[];
  readonly exits: readonly NativeTraceExit[];
  readonly totalBytes: number;
  readonly totalEvents: number;
  readonly truncated: boolean;
  readonly truncationReason?: NativeTraceTruncationReason;
}

export type NativeTraceTruncationReason =
  | "byte-limit"
  | "event-limit"
  | "time-limit"
  | "lifecycle-error";

export interface NativeTraceFixtureIdentity {
  readonly id: string;
  readonly label: string;
  readonly synthetic: boolean;
}

export interface NativeTraceProvenance {
  readonly source: string;
  readonly sourceSha256: string | readonly string[];
  readonly capturedAt?: string;
  readonly reviewer?: string;
}

export interface NativeTraceRuntime {
  readonly kind: NativeTraceRuntimeKind;
  readonly version: string;
  readonly revision: string;
}

export interface NativeTraceProtocol {
  readonly name: string;
  readonly version: string;
}

export type NativeTraceCapabilityValue = boolean | number | string;
export type NativeTraceCapabilities = Readonly<Record<string, NativeTraceCapabilityValue>>;

export interface NativeTraceChunkManifest {
  readonly sequence: number;
  readonly stream: NativeTraceStream;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface NativeTraceExitManifest {
  readonly sequence: number;
  readonly code: number | null;
  readonly signal: string | null;
}

export interface NativeTraceCaptureManifest {
  readonly chunks: readonly NativeTraceChunkManifest[];
  readonly exits: readonly NativeTraceExitManifest[];
  readonly totalBytes: number;
  readonly totalEvents: number;
  readonly byteSha256: string;
  readonly truncated: boolean;
}

export interface NativeTraceNormalizationManifest {
  readonly version: number;
  readonly strategy: string;
}

export interface NativeTraceRedactionReport {
  readonly version: number;
  readonly reviewed: boolean;
  readonly leakScanPassed: boolean;
  readonly failedClosed: boolean;
  readonly redactedPaths: readonly string[];
  readonly unknownPaths: readonly string[];
  readonly sourceSha256: string;
  readonly outputSha256: string;
  readonly reportHash: string;
}

export interface NativeTraceRedactionManifest {
  readonly version: number;
  readonly reviewed: boolean;
  readonly leakScanPassed: boolean;
  readonly reportHash: string;
  readonly unknownPaths: readonly string[];
  readonly report: NativeTraceRedactionReport;
}

export interface NativeTraceExpectedOutcome {
  readonly fixtureId: string;
  readonly sha256: string;
  readonly value: unknown;
}

export interface NativeTraceCompatibility {
  readonly minSchemaVersion: number;
  readonly maxSchemaVersion: number;
  readonly runtimes?: readonly string[];
}

export interface NativeTraceManifest {
  readonly fixture: NativeTraceFixtureIdentity;
  readonly provenance: NativeTraceProvenance;
  readonly runtime: NativeTraceRuntime;
  readonly protocol: NativeTraceProtocol;
  readonly capabilities: NativeTraceCapabilities;
  readonly capture: NativeTraceCaptureManifest;
  readonly normalization: NativeTraceNormalizationManifest;
  readonly redaction: NativeTraceRedactionManifest;
  readonly expectedOutcome: NativeTraceExpectedOutcome;
  readonly compatibility: NativeTraceCompatibility;
}
export type NativeTraceCaptureChunk = NativeTraceChunk;
export type NativeTraceCaptureExit = NativeTraceExit;
export type NativeTraceFixtureManifest = NativeTraceManifest;

export interface NativeTraceCaptureEnvelope {
  readonly schemaVersion: typeof NATIVE_TRACE_SCHEMA_VERSION;
  readonly kind: "native-trace";
  readonly manifest?: NativeTraceManifest;
  readonly capture: NativeTraceCapture;
}

export type NativeTraceEnvelope = NativeTraceCaptureEnvelope;
export type NativeTraceFixture = NativeTraceCaptureEnvelope;

const SHA256_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();

export function sha256NativeTraceBytes(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

export function canonicalNativeTraceJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Uint8Array) return canonicalNativeTraceJson(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(canonicalNativeTraceJson).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(String(value));
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalNativeTraceJson(record[key])}`)
    .join(",")}}`;
}

export function sha256NativeTraceValue(value: unknown): string {
  return sha256NativeTraceBytes(encoder.encode(canonicalNativeTraceJson(value)));
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!BASE64_RE.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return undefined;
  return new Uint8Array(decoded);
}

function concatNativeTraceBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${path}.${key}: unsafe unknown field`);
  }
}

function requireRecord(value: unknown, path: string, issues: string[]): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    issues.push(
      value === undefined ? `${path}: missing required object` : `${path}: expected object`,
    );
  }
  return record ?? {};
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    issues.push(`${path}.${key}: required non-empty string`);
  return typeof value === "string" ? value : "";
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 0)
    issues.push(`${path}.${key}: required non-negative integer`);
  return typeof value === "number" ? value : -1;
}

function requireHash(value: unknown, path: string, issues: string[]): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) issues.push(`${path}: invalid sha256`);
  return typeof value === "string" ? value : "";
}

function validateManifest(
  manifestValue: unknown,
  envelope: NativeTraceCaptureEnvelope,
  issues: string[],
): void {
  const manifest = requireRecord(manifestValue, "manifest", issues);
  assertAllowedKeys(
    manifest,
    [
      "fixture",
      "provenance",
      "runtime",
      "protocol",
      "capabilities",
      "capture",
      "normalization",
      "redaction",
      "expectedOutcome",
      "compatibility",
    ],
    "manifest",
    issues,
  );

  const fixture = requireRecord(manifest.fixture, "manifest.fixture", issues);
  assertAllowedKeys(fixture, ["id", "label", "synthetic"], "manifest.fixture", issues);
  const fixtureId = requireString(fixture, "id", "manifest.fixture", issues);
  requireString(fixture, "label", "manifest.fixture", issues);
  if (typeof fixture.synthetic !== "boolean")
    issues.push("manifest.fixture.synthetic: required boolean");

  const provenance = requireRecord(manifest.provenance, "manifest.provenance", issues);
  assertAllowedKeys(
    provenance,
    ["source", "sourceSha256", "capturedAt", "reviewer"],
    "manifest.provenance",
    issues,
  );
  requireString(provenance, "source", "manifest.provenance", issues);
  const sourceHash = provenance.sourceSha256;
  if (Array.isArray(sourceHash)) {
    if (sourceHash.length === 0) issues.push("manifest.provenance.sourceSha256: empty");
    sourceHash.forEach((hash, index) =>
      requireHash(hash, `manifest.provenance.sourceSha256[${index}]`, issues),
    );
  } else requireHash(sourceHash, "manifest.provenance.sourceSha256", issues);
  if (provenance.capturedAt !== undefined && typeof provenance.capturedAt !== "string")
    issues.push("manifest.provenance.capturedAt: invalid");
  if (provenance.reviewer !== undefined && typeof provenance.reviewer !== "string")
    issues.push("manifest.provenance.reviewer: invalid");

  const runtime = requireRecord(manifest.runtime, "manifest.runtime", issues);
  assertAllowedKeys(runtime, ["kind", "version", "revision"], "manifest.runtime", issues);
  requireString(runtime, "kind", "manifest.runtime", issues);
  requireString(runtime, "version", "manifest.runtime", issues);
  requireString(runtime, "revision", "manifest.runtime", issues);

  const protocol = requireRecord(manifest.protocol, "manifest.protocol", issues);
  assertAllowedKeys(protocol, ["name", "version"], "manifest.protocol", issues);
  requireString(protocol, "name", "manifest.protocol", issues);
  requireString(protocol, "version", "manifest.protocol", issues);

  const capabilities = requireRecord(manifest.capabilities, "manifest.capabilities", issues);
  for (const [key, value] of Object.entries(capabilities)) {
    if (!["boolean", "number", "string"].includes(typeof value))
      issues.push(`manifest.capabilities.${key}: unsafe value`);
  }

  const capture = requireRecord(manifest.capture, "manifest.capture", issues);
  assertAllowedKeys(
    capture,
    ["chunks", "exits", "totalBytes", "totalEvents", "byteSha256", "truncated"],
    "manifest.capture",
    issues,
  );
  const captureChunks = Array.isArray(capture.chunks) ? capture.chunks : [];
  if (!Array.isArray(capture.chunks)) issues.push("manifest.capture.chunks: required array");
  const captureExits = Array.isArray(capture.exits) ? capture.exits : [];
  if (!Array.isArray(capture.exits)) issues.push("manifest.capture.exits: required array");
  if (captureExits.length !== 1) issues.push("manifest.capture.exits: required exactly one");
  if (
    captureExits.length === 1 &&
    asRecord(captureExits[0])?.sequence !== Number(capture.totalEvents) - 1
  ) {
    issues.push("manifest.capture.exits: exit must be the terminal event");
  }
  const chunkManifestBySequence = new Map<number, Record<string, unknown>>();
  for (const [index, chunkValue] of captureChunks.entries()) {
    const chunk = requireRecord(chunkValue, `manifest.capture.chunks[${index}]`, issues);
    assertAllowedKeys(
      chunk,
      ["sequence", "stream", "byteLength", "sha256"],
      `manifest.capture.chunks[${index}]`,
      issues,
    );
    const sequence = requireInteger(chunk, "sequence", `manifest.capture.chunks[${index}]`, issues);
    if (chunkManifestBySequence.has(sequence))
      issues.push(`manifest.capture.chunks[${index}]: duplicate sequence`);
    chunkManifestBySequence.set(sequence, chunk);
    if (!["stdin", "stdout", "stderr"].includes(String(chunk.stream)))
      issues.push(`manifest.capture.chunks[${index}].stream: invalid`);
    requireInteger(chunk, "byteLength", `manifest.capture.chunks[${index}]`, issues);
    requireHash(chunk.sha256, `manifest.capture.chunks[${index}].sha256`, issues);
  }
  const exitManifestBySequence = new Map<number, Record<string, unknown>>();
  for (const [index, exitValue] of captureExits.entries()) {
    const exit = requireRecord(exitValue, `manifest.capture.exits[${index}]`, issues);
    assertAllowedKeys(
      exit,
      ["sequence", "code", "signal"],
      `manifest.capture.exits[${index}]`,
      issues,
    );
    const sequence = requireInteger(exit, "sequence", `manifest.capture.exits[${index}]`, issues);
    if (exitManifestBySequence.has(sequence))
      issues.push(`manifest.capture.exits[${index}]: duplicate sequence`);
    exitManifestBySequence.set(sequence, exit);
    if (exit.code !== null && !Number.isInteger(exit.code))
      issues.push(`manifest.capture.exits[${index}].code: invalid`);
    if (exit.signal !== null && typeof exit.signal !== "string")
      issues.push(`manifest.capture.exits[${index}].signal: invalid`);
  }
  requireInteger(capture, "totalBytes", "manifest.capture", issues);
  requireInteger(capture, "totalEvents", "manifest.capture", issues);
  requireHash(capture.byteSha256, "manifest.capture.byteSha256", issues);
  if (typeof capture.truncated !== "boolean")
    issues.push("manifest.capture.truncated: required boolean");

  const normalization = requireRecord(manifest.normalization, "manifest.normalization", issues);
  assertAllowedKeys(normalization, ["version", "strategy"], "manifest.normalization", issues);
  if (normalization.version !== NATIVE_TRACE_NORMALIZATION_VERSION)
    issues.push("manifest.normalization.version: unsupported");
  requireString(normalization, "strategy", "manifest.normalization", issues);

  const redaction = requireRecord(manifest.redaction, "manifest.redaction", issues);
  assertAllowedKeys(
    redaction,
    ["version", "reviewed", "leakScanPassed", "reportHash", "unknownPaths", "report"],
    "manifest.redaction",
    issues,
  );
  if (redaction.version !== NATIVE_TRACE_REDACTION_VERSION)
    issues.push("manifest.redaction.version: unsupported");
  if (redaction.reviewed !== true) issues.push("manifest.redaction: unreviewed redaction");
  if (redaction.leakScanPassed !== true) issues.push("manifest.redaction: leak scan failed");
  const manifestReportHash = requireHash(
    redaction.reportHash,
    "manifest.redaction.reportHash",
    issues,
  );
  if (!Array.isArray(redaction.unknownPaths) || redaction.unknownPaths.length > 0)
    issues.push("manifest.redaction: unsafe unknown fields");

  const report = requireRecord(redaction.report, "manifest.redaction.report", issues);
  assertAllowedKeys(
    report,
    [
      "version",
      "reviewed",
      "leakScanPassed",
      "failedClosed",
      "redactedPaths",
      "unknownPaths",
      "sourceSha256",
      "outputSha256",
      "reportHash",
    ],
    "manifest.redaction.report",
    issues,
  );
  const reportHash = requireHash(report.reportHash, "manifest.redaction.report.reportHash", issues);
  requireHash(report.sourceSha256, "manifest.redaction.report.sourceSha256", issues);
  const redactedSubjectHash = requireHash(
    report.outputSha256,
    "manifest.redaction.report.outputSha256",
    issues,
  );
  const reportWithoutHash = { ...report };
  delete reportWithoutHash.reportHash;
  if (sha256NativeTraceValue(reportWithoutHash) !== reportHash || reportHash !== manifestReportHash)
    issues.push("manifest.redaction.reportHash: mismatch");
  if (report.failedClosed !== false || report.reviewed !== true || report.leakScanPassed !== true)
    issues.push("manifest.redaction.report: not reviewed");
  const redactedPaths = Array.isArray(report.redactedPaths) ? report.redactedPaths : [];
  const unknownPaths = Array.isArray(report.unknownPaths) ? report.unknownPaths : [];
  if (
    !Array.isArray(report.redactedPaths) ||
    redactedPaths.some((path) => typeof path !== "string") ||
    !Array.isArray(report.unknownPaths) ||
    unknownPaths.some((path) => typeof path !== "string") ||
    unknownPaths.length !== 0
  ) {
    issues.push("manifest.redaction.report: invalid path metadata");
  }
  if (scanNativeTraceLeaks(report).length > 0)
    issues.push("manifest.redaction.report: sensitive report metadata remains");

  const expected = requireRecord(manifest.expectedOutcome, "manifest.expectedOutcome", issues);
  assertAllowedKeys(expected, ["fixtureId", "sha256", "value"], "manifest.expectedOutcome", issues);
  requireHash(expected.sha256, "manifest.expectedOutcome.sha256", issues);
  if (!("value" in expected)) issues.push("manifest.expectedOutcome: missing output");
  if (expected.fixtureId !== fixtureId) issues.push("manifest.expectedOutcome.fixtureId: mismatch");
  if ("value" in expected && sha256NativeTraceValue(expected.value) !== expected.sha256)
    issues.push("manifest.expectedOutcome.sha256: mismatch");

  const compatibility = requireRecord(manifest.compatibility, "manifest.compatibility", issues);
  assertAllowedKeys(
    compatibility,
    ["minSchemaVersion", "maxSchemaVersion", "runtimes"],
    "manifest.compatibility",
    issues,
  );
  const minSchema = requireInteger(
    compatibility,
    "minSchemaVersion",
    "manifest.compatibility",
    issues,
  );
  const maxSchema = requireInteger(
    compatibility,
    "maxSchemaVersion",
    "manifest.compatibility",
    issues,
  );
  if (
    minSchema > maxSchema ||
    NATIVE_TRACE_SCHEMA_VERSION < minSchema ||
    NATIVE_TRACE_SCHEMA_VERSION > maxSchema
  )
    issues.push("manifest.compatibility: unsupported schema");
  if (
    compatibility.runtimes !== undefined &&
    (!Array.isArray(compatibility.runtimes) ||
      compatibility.runtimes.some((runtime) => typeof runtime !== "string"))
  ) {
    issues.push("manifest.compatibility.runtimes: invalid");
  }
  const redactionSubject = {
    fixture,
    provenance,
    runtime,
    protocol,
    capabilities,
    capture: envelope.capture,
    normalization,
    expectedOutcome: expected.value,
    compatibility,
  };
  if (sha256NativeTraceValue(redactionSubject) !== redactedSubjectHash)
    issues.push("manifest.redaction.report: subject mismatch");
  if (scanNativeTraceLeaks(redactionSubject).length > 0)
    issues.push("manifest.redaction.report: sensitive subject patterns remain");

  const actualCapture = asRecord(envelope.capture) ?? {};
  const actualChunks = Array.isArray(actualCapture.chunks) ? actualCapture.chunks : [];
  const actualExits = Array.isArray(actualCapture.exits) ? actualCapture.exits : [];
  if (capture.totalBytes !== actualCapture.totalBytes)
    issues.push("manifest.capture.totalBytes: mismatch");
  if (capture.totalEvents !== actualCapture.totalEvents)
    issues.push("manifest.capture.totalEvents: mismatch");
  if (capture.truncated !== actualCapture.truncated)
    issues.push("manifest.capture.truncated: mismatch");
  if (captureChunks.length !== actualChunks.length)
    issues.push("manifest.capture.chunks: mismatch");
  if (captureExits.length !== actualExits.length) issues.push("manifest.capture.exits: mismatch");
  const orderedBytes: Uint8Array[] = [];
  for (const chunkValue of [...actualChunks].sort((left, right) => {
    const leftSequence = asRecord(left)?.sequence;
    const rightSequence = asRecord(right)?.sequence;
    return (
      (typeof leftSequence === "number" ? leftSequence : -1) -
      (typeof rightSequence === "number" ? rightSequence : -1)
    );
  })) {
    const chunk = asRecord(chunkValue);
    if (!chunk) continue;
    const bytes =
      typeof chunk.bytesBase64 === "string" ? decodeBase64(chunk.bytesBase64) : undefined;
    if (bytes) orderedBytes.push(bytes);
    const sequence = typeof chunk.sequence === "number" ? chunk.sequence : -1;
    const expectedChunk = chunkManifestBySequence.get(sequence);
    if (!expectedChunk) {
      issues.push(`manifest.capture.chunks: missing sequence ${sequence}`);
      continue;
    }
    const actualHash = bytes === undefined ? "" : sha256NativeTraceBytes(bytes);
    if (
      expectedChunk.stream !== chunk.stream ||
      expectedChunk.byteLength !== chunk.byteLength ||
      expectedChunk.sha256 !== actualHash
    )
      issues.push(`manifest.capture.chunks[${sequence}]: mismatch`);
  }
  if (capture.byteSha256 !== sha256NativeTraceBytes(concatNativeTraceBytes(orderedBytes)))
    issues.push("manifest.capture.byteSha256: mismatch");
  for (const exitValue of actualExits) {
    const exit = asRecord(exitValue);
    if (!exit) continue;
    const sequence = typeof exit.sequence === "number" ? exit.sequence : -1;
    const expectedExit = exitManifestBySequence.get(sequence);
    if (!expectedExit || expectedExit.code !== exit.code || expectedExit.signal !== exit.signal)
      issues.push(`manifest.capture.exits[${sequence}]: mismatch`);
  }
}

/** Validate one complete fixture, throwing instead of silently accepting unsafe input. */
export function validateNativeTraceFixture(fixtureValue: unknown): NativeTraceCaptureEnvelope {
  const issues: string[] = [];
  const envelope = requireRecord(fixtureValue, "fixture", issues);
  assertAllowedKeys(envelope, ["schemaVersion", "kind", "manifest", "capture"], "fixture", issues);
  if (envelope.schemaVersion !== NATIVE_TRACE_SCHEMA_VERSION)
    issues.push("fixture.schemaVersion: unsupported schema");
  if (envelope.kind !== "native-trace") issues.push("fixture.kind: unsupported");
  if (envelope.manifest === undefined) issues.push("fixture.manifest: missing provenance");
  const capture = requireRecord(envelope.capture, "fixture.capture", issues);
  assertAllowedKeys(
    capture,
    ["chunks", "exits", "totalBytes", "totalEvents", "truncated", "truncationReason"],
    "fixture.capture",
    issues,
  );
  const chunks = Array.isArray(capture.chunks) ? capture.chunks : [];
  const exits = Array.isArray(capture.exits) ? capture.exits : [];
  if (!Array.isArray(capture.chunks)) issues.push("fixture.capture.chunks: required array");
  if (!Array.isArray(capture.exits)) issues.push("fixture.capture.exits: required array");
  const sequences: number[] = [];
  const decodedChunks: Array<{
    readonly sequence: number;
    readonly stream: NativeTraceStream;
    readonly bytes: Uint8Array;
  }> = [];
  let previousChunkSequence = -1;
  let totalBytes = 0;
  for (const [index, value] of chunks.entries()) {
    const chunk = requireRecord(value, `fixture.capture.chunks[${index}]`, issues);
    assertAllowedKeys(
      chunk,
      ["sequence", "stream", "byteLength", "bytesBase64"],
      `fixture.capture.chunks[${index}]`,
      issues,
    );
    const sequence = requireInteger(chunk, "sequence", `fixture.capture.chunks[${index}]`, issues);
    sequences.push(sequence);
    if (sequence <= previousChunkSequence)
      issues.push("fixture.capture.chunks: non-canonical sequence order");
    previousChunkSequence = sequence;
    if (!["stdin", "stdout", "stderr"].includes(String(chunk.stream)))
      issues.push(`fixture.capture.chunks[${index}].stream: invalid`);
    const byteLength = requireInteger(
      chunk,
      "byteLength",
      `fixture.capture.chunks[${index}]`,
      issues,
    );
    const bytes =
      typeof chunk.bytesBase64 === "string" ? decodeBase64(chunk.bytesBase64) : undefined;
    if (!bytes) {
      issues.push(`fixture.capture.chunks[${index}].bytesBase64: invalid base64`);
    } else {
      if (bytes.byteLength !== byteLength)
        issues.push(`fixture.capture.chunks[${index}].byteLength: mismatch`);
      if (chunk.stream === "stdin" || chunk.stream === "stdout" || chunk.stream === "stderr") {
        decodedChunks.push({ sequence, stream: chunk.stream, bytes });
      }
    }
    totalBytes += byteLength >= 0 ? byteLength : 0;
  }
  const bytePartsByStream = new Map<NativeTraceStream, Uint8Array[]>();
  for (const chunk of [...decodedChunks].sort((left, right) => left.sequence - right.sequence)) {
    const streamParts = bytePartsByStream.get(chunk.stream) ?? [];
    streamParts.push(chunk.bytes);
    bytePartsByStream.set(chunk.stream, streamParts);
  }
  for (const [stream, parts] of bytePartsByStream) {
    const bytes = concatNativeTraceBytes(parts);
    const findings = new Set<string>();
    for (const leak of scanNativeTraceLeaks(new TextDecoder().decode(bytes))) findings.add(leak);
    scanNativeTraceJsonlBytes(stream, bytes, findings);
    if (findings.size > 0) issues.push(`fixture.capture.${stream}: sensitive byte patterns remain`);
  }
  let previousExitSequence = -1;
  if (exits.length !== 1) issues.push("fixture.capture.exits: required exactly one");
  if (exits.length === 1 && asRecord(exits[0])?.sequence !== Number(capture.totalEvents) - 1)
    issues.push("fixture.capture.exits: exit must be the terminal event");
  for (const [index, value] of exits.entries()) {
    const exit = requireRecord(value, `fixture.capture.exits[${index}]`, issues);
    assertAllowedKeys(
      exit,
      ["sequence", "code", "signal"],
      `fixture.capture.exits[${index}]`,
      issues,
    );
    const sequence = requireInteger(exit, "sequence", `fixture.capture.exits[${index}]`, issues);
    sequences.push(sequence);
    if (sequence <= previousExitSequence)
      issues.push("fixture.capture.exits: non-canonical sequence order");
    previousExitSequence = sequence;
    if (exit.code !== null && !Number.isInteger(exit.code))
      issues.push(`fixture.capture.exits[${index}].code: invalid`);
    if (exit.signal !== null && typeof exit.signal !== "string")
      issues.push(`fixture.capture.exits[${index}].signal: invalid`);
  }
  const sortedSequences = [...sequences].sort((left, right) => left - right);
  if (sortedSequences.some((sequence, index) => sequence !== index))
    issues.push("fixture.capture: inconsistent chunk sequences");
  if (capture.totalBytes !== totalBytes) issues.push("fixture.capture.totalBytes: mismatch");
  if (capture.totalEvents !== sequences.length)
    issues.push("fixture.capture.totalEvents: mismatch");
  if (capture.truncated === true)
    issues.push("fixture.capture: truncated capture is not publishable");
  if (capture.truncated !== false) issues.push("fixture.capture.truncated: required false");
  if (capture.truncationReason !== undefined)
    issues.push("fixture.capture.truncationReason: unexpected");

  const normalizedEnvelope = envelope as unknown as NativeTraceCaptureEnvelope;
  if (envelope.manifest !== undefined)
    validateManifest(envelope.manifest, normalizedEnvelope, issues);
  if (issues.length > 0) throw new NativeTraceFixtureValidationError(issues);
  return normalizedEnvelope;
}

export function validateNativeTraceCorpus(
  fixtures: readonly unknown[],
): readonly NativeTraceCaptureEnvelope[] {
  const seen = new Set<string>();
  const validated: NativeTraceCaptureEnvelope[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const envelope = validateNativeTraceFixture(fixture);
    const manifest = envelope.manifest;
    if (!manifest)
      throw new NativeTraceFixtureValidationError([`corpus[${index}]: missing manifest`]);
    const id = manifest.fixture.id;
    if (seen.has(id))
      throw new NativeTraceFixtureValidationError([`corpus[${index}]: duplicate fixture ID ${id}`]);
    seen.add(id);
    validated.push(envelope);
  }
  return validated;
}

export const assertNativeTraceFixture = validateNativeTraceFixture;
export const assertNativeTraceCorpus = validateNativeTraceCorpus;

export class NativeTraceFixtureValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid native trace fixture: ${issues.join("; ")}`);
    this.name = "NativeTraceFixtureValidationError";
    this.issues = [...issues];
  }
}

export class NativeTraceRedactionError extends Error {
  readonly paths: readonly string[];
  constructor(message: string, paths: readonly string[] = []) {
    super(message);
    this.name = "NativeTraceRedactionError";
    this.paths = [...paths];
  }
}

export class NativeTraceRecorderLimitError extends Error {
  readonly reason: NativeTraceTruncationReason;
  constructor(reason: NativeTraceTruncationReason) {
    super(`Native trace recorder ${reason}`);
    this.name = "NativeTraceRecorderLimitError";
    this.reason = reason;
  }
}

export interface BoundedNativeTraceRecorderLimits {
  readonly maxBytes: number;
  readonly maxEvents: number;
  readonly maxDurationMs: number;
}

export interface BoundedNativeTraceRecorderOptions {
  readonly maxBytes?: number;
  readonly maxEvents?: number;
  readonly maxDurationMs?: number;
  readonly limits?: Partial<BoundedNativeTraceRecorderLimits>;
  readonly nowMs?: () => number;
  readonly manifest?: NativeTraceManifest;
}

function checkedLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0)
    throw new RangeError(`${name} must be a finite non-negative number`);
  return Math.floor(result);
}

/**
 * Opt-in, in-memory recorder. It never writes to a path and does not install a
 * clock or process hook. Limit failures are observable and permanently mark the
 * capture truncated so callers cannot accidentally treat a partial trace as complete.
 */
export class BoundedNativeTraceRecorder implements NativeTraceSink {
  readonly limits: BoundedNativeTraceRecorderLimits;
  private readonly nowMs: () => number;
  private readonly startedAt: number;
  private readonly manifest: NativeTraceManifest | undefined;
  private readonly chunks: NativeTraceChunk[] = [];
  private readonly exits: NativeTraceExit[] = [];
  private nextSequence = 0;
  private totalBytes = 0;
  private truncationReason?: NativeTraceTruncationReason;
  private finalized = false;

  constructor(options: BoundedNativeTraceRecorderOptions = {}) {
    const supplied = options.limits ?? {};
    this.limits = {
      maxBytes: checkedLimit(options.maxBytes ?? supplied.maxBytes, 1024 * 1024, "maxBytes"),
      maxEvents: checkedLimit(options.maxEvents ?? supplied.maxEvents, 4096, "maxEvents"),
      maxDurationMs: checkedLimit(
        options.maxDurationMs ?? supplied.maxDurationMs,
        60_000,
        "maxDurationMs",
      ),
    };
    this.nowMs = options.nowMs ?? (() => NodePerfHooks.performance.now());
    this.startedAt = this.nowMs();
    this.manifest = options.manifest;
  }

  private markExpired(): void {
    if (this.finalized) return;
    if (
      this.truncationReason === undefined &&
      this.nowMs() - this.startedAt > this.limits.maxDurationMs
    ) {
      this.truncationReason = "time-limit";
    }
  }

  private checkLimit(additionalBytes: number): void {
    this.markExpired();
    if (this.truncationReason) throw new NativeTraceRecorderLimitError(this.truncationReason);
    if (this.finalized) throw new Error("Native trace recorder is finalized");
    if (this.chunks.length + this.exits.length >= this.limits.maxEvents) {
      this.truncationReason = "event-limit";
      throw new NativeTraceRecorderLimitError("event-limit");
    }
    if (this.totalBytes + additionalBytes > this.limits.maxBytes) {
      this.truncationReason = "byte-limit";
      throw new NativeTraceRecorderLimitError("byte-limit");
    }
  }

  recordBytes(stream: NativeTraceStream, bytes: Uint8Array): void {
    if (stream !== "stdin" && stream !== "stdout" && stream !== "stderr")
      throw new TypeError("invalid native trace stream");
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("native trace bytes must be Uint8Array");
    this.checkLimit(bytes.byteLength);
    this.chunks.push({
      sequence: this.nextSequence++,
      stream,
      byteLength: bytes.byteLength,
      bytesBase64: Buffer.from(bytes).toString("base64"),
    });
    this.totalBytes += bytes.byteLength;
  }

  recordExit(code: number | null, signal: string | null): void {
    if (code !== null && !Number.isInteger(code))
      throw new TypeError("native trace exit code must be an integer or null");
    if (signal !== null && typeof signal !== "string")
      throw new TypeError("native trace signal must be a string or null");
    this.checkLimit(0);
    this.exits.push({ sequence: this.nextSequence++, code, signal });
  }

  invalidate(): void {
    if (this.finalized || this.truncationReason !== undefined) return;
    this.truncationReason = "lifecycle-error";
  }

  finalize(): void {
    if (this.finalized) return;
    this.markExpired();
    this.finalized = true;
    if (this.truncationReason) throw new NativeTraceRecorderLimitError(this.truncationReason);
  }

  get truncated(): boolean {
    return this.truncationReason !== undefined;
  }

  get truncationReasonValue(): NativeTraceTruncationReason | undefined {
    return this.truncationReason;
  }

  toEnvelope(): NativeTraceCaptureEnvelope {
    this.markExpired();
    const capture: NativeTraceCapture = {
      chunks: this.chunks.map((chunk) => ({ ...chunk })),
      exits: this.exits.map((exit) => ({ ...exit })),
      totalBytes: this.totalBytes,
      totalEvents: this.chunks.length + this.exits.length,
      truncated: this.truncated,
      ...(this.truncationReason === undefined ? {} : { truncationReason: this.truncationReason }),
    };
    return {
      schemaVersion: NATIVE_TRACE_SCHEMA_VERSION,
      kind: "native-trace",
      ...(this.manifest === undefined ? {} : { manifest: this.manifest }),
      capture,
    };
  }

  snapshot(): NativeTraceCaptureEnvelope {
    return this.toEnvelope();
  }

  capture(): NativeTraceCaptureEnvelope {
    return this.toEnvelope();
  }
}

const DEFAULT_ALLOWED_KEYS = new Set([
  "type",
  "kind",
  "event",
  "method",
  "stream",
  "sequence",
  "byteLength",
  "bytesBase64",
  "code",
  "signal",
  "status",
  "outcome",
  "role",
  "name",
  "toolName",
  "toolCallId",
  "id",
  "eventId",
  "requestId",
  "sessionId",
  "turnId",
  "taskId",
  "itemId",
  "parentId",
  "parentTaskId",
  "parentToolCallId",
  "runId",
  "contentIndex",
  "index",
  "detached",
  "isError",
  "accepted",
  "agentInvoked",
  "willRetry",
  "isTerminal",
  "synthetic",
  "runtime",
  "runtimeKind",
  "protocol",
  "version",
  "revision",
  "capabilities",
  "fixtureId",
  "label",
  "source",
  "sourceSha256",
  "capturedAt",
  "reviewer",
  "provenance",
  "capture",
  "value",
  "events",
  "chunks",
  "exits",
  "totalBytes",
  "totalEvents",
  "truncated",
  "truncationReason",
  "schemaVersion",
  "normalization",
  "redaction",
  "expectedOutcome",
  "compatibility",
]);
const DEFAULT_SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|token|api[-_]?key|signature|encrypted|prompt|content|text|message|delta|args|result|data|payload|input|output|query|description|email|username|home|cwd|path|environment|env|usage|cost|timestamp|startedAt|endedAt|createdAt|updatedAt|pid|process/i;
const DEFAULT_BYTE_SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|token|api[-_]?key|signature|encrypted|prompt|content|text|message|delta|args|result|data|payload|input|output|query|description|command|email|username|home|cwd|path|environment|env|usage|cost|timestamp|startedAt|endedAt|createdAt|updatedAt|pid|process/i;
const DEFAULT_LEAK_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+\-/=]{8,}/iu,
  /\b(?:authorization|auth|cookie|credential|password|secret|token|api[-_ ]?key)["']?\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"',;}\]]+/iu,
  /\b(?:sk|rk|xox[baprs])-[A-Za-z0-9_-]{8,}\b/iu,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/iu,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"']+/u,
  /(?:\/private\/(?:var|tmp)\/|\/var\/folders\/|\/tmp\/)[^\s"']+/u,
  /\bgit@[A-Za-z0-9.-]+:[^\s"']+\.git\b/u,
  /https?:\/\/[^\s/"']+:[^@\s"']+@[^\s"']+/u,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

export interface NativeTraceRedactionOptions {
  readonly allowedKeys?: readonly string[];
  readonly sensitiveKeys?: readonly (string | RegExp)[];
  readonly leakPatterns?: readonly (string | RegExp)[];
  readonly preserveByteLength?: boolean;
  readonly reviewed?: boolean;
  readonly failClosed?: boolean;
}

export interface NativeTraceRedactionResult {
  readonly value: unknown;
  readonly report: NativeTraceRedactionReport;
}

function keyMatches(key: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return key.toLowerCase() === pattern.toLowerCase();
    pattern.lastIndex = 0;
    return pattern.test(key);
  });
}

function preserveLength(original: string, replacement: string): string {
  const target = encoder.encode(original).byteLength;
  const replacementBytes = encoder.encode(replacement);
  if (replacementBytes.byteLength === target) return replacement;
  if (replacementBytes.byteLength < target)
    return `${replacement}${"~".repeat(target - replacementBytes.byteLength)}`;
  return new TextDecoder().decode(replacementBytes.subarray(0, target));
}

function placeholder(original: string, preserve: boolean): string {
  return preserve ? preserveLength(original, "[REDACTED]") : "[REDACTED]";
}

function reportHash(report: Omit<NativeTraceRedactionReport, "reportHash">): string {
  return sha256NativeTraceValue(report);
}

export function scanNativeTraceLeaks(
  value: unknown,
  patterns: readonly (string | RegExp)[] = DEFAULT_LEAK_PATTERNS,
): readonly string[] {
  const text = canonicalNativeTraceJson(value);
  const findings: string[] = [];
  for (const pattern of patterns) {
    const regex = typeof pattern === "string" ? new RegExp(pattern, "u") : pattern;
    regex.lastIndex = 0;
    if (regex.test(text)) findings.push(typeof pattern === "string" ? pattern : pattern.source);
  }
  return findings;
}

function isPublicationSafeSensitiveValue(
  key: string,
  value: unknown,
  parent: Readonly<Record<string, unknown>>,
): boolean {
  if (
    key.toLowerCase() === "command" &&
    parent.type === "response" &&
    typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(value)
  ) {
    return true;
  }
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") {
    return value.length === 0 || value.startsWith("[REDACTED]") || value.startsWith("[normalized:");
  }
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function scanNativeTraceStructuredByteValue(
  value: unknown,
  path: string,
  findings: Set<string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanNativeTraceStructuredByteValue(entry, `${path}[${index}]`, findings),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Readonly<Record<string, unknown>>;
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (keyMatches(key, [DEFAULT_BYTE_SENSITIVE_KEY])) {
      if (!isPublicationSafeSensitiveValue(key, child, record))
        findings.add(`sensitive-key:${childPath}`);
      continue;
    }
    scanNativeTraceStructuredByteValue(child, childPath, findings);
  }
}

function scanNativeTraceJsonlBytes(
  stream: NativeTraceStream,
  bytes: Uint8Array,
  findings: Set<string>,
): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    findings.add(`${stream}:invalid-utf8`);
    return;
  }
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  lines.forEach((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      if (stream !== "stderr") findings.add(`${stream}:invalid-jsonl:${index}`);
      return;
    }
    if (stream === "stderr") {
      scanNativeTraceStructuredByteValue(frame, `${stream}[${index}]`, findings);
      return;
    }
    if (
      typeof frame !== "object" ||
      frame === null ||
      Array.isArray(frame) ||
      typeof (frame as Record<string, unknown>).type !== "string"
    ) {
      findings.add(`${stream}:invalid-envelope:${index}`);
      return;
    }
    scanNativeTraceStructuredByteValue(frame, `${stream}[${index}]`, findings);
  });
}

function scanNativeTraceCaptureByteLeaks(capture: NativeTraceCapture): readonly string[] {
  const bytePartsByStream = new Map<NativeTraceStream, Uint8Array[]>();
  const findings = new Set<string>();
  for (const chunk of [...capture.chunks].sort((left, right) => left.sequence - right.sequence)) {
    const bytes = decodeBase64(chunk.bytesBase64);
    if (!bytes) {
      findings.add(`${chunk.stream}:invalid-base64`);
      continue;
    }
    const streamParts = bytePartsByStream.get(chunk.stream) ?? [];
    streamParts.push(bytes);
    bytePartsByStream.set(chunk.stream, streamParts);
  }
  for (const [stream, parts] of bytePartsByStream) {
    const bytes = concatNativeTraceBytes(parts);
    for (const finding of scanNativeTraceLeaks(new TextDecoder().decode(bytes))) {
      findings.add(`${stream}:${finding}`);
    }
    scanNativeTraceJsonlBytes(stream, bytes, findings);
  }
  return [...findings];
}

export function redactNativeTrace(
  value: unknown,
  options: NativeTraceRedactionOptions = {},
): NativeTraceRedactionResult {
  const allowedKeys = new Set(options.allowedKeys ?? DEFAULT_ALLOWED_KEYS);
  const sensitiveKeys = options.sensitiveKeys ?? [DEFAULT_SENSITIVE_KEY];
  const leakPatterns = options.leakPatterns ?? DEFAULT_LEAK_PATTERNS;
  const preserve = options.preserveByteLength === true;
  const failClosed = options.failClosed !== false;
  const redactedPaths: string[] = [];
  const unknownPaths: string[] = [];
  const redact = (input: unknown, key: string, path: string): unknown => {
    if (key && keyMatches(key, sensitiveKeys)) {
      redactedPaths.push(path);
      return typeof input === "string" ? placeholder(input, preserve) : "[REDACTED]";
    }
    if (typeof input === "string") {
      if (scanNativeTraceLeaks(input, leakPatterns).length > 0) {
        redactedPaths.push(path);
        return placeholder(input, preserve);
      }
      return input;
    }
    if (
      input === null ||
      typeof input === "number" ||
      typeof input === "boolean" ||
      typeof input === "undefined"
    )
      return input;
    if (input instanceof Uint8Array) return Buffer.from(input).toString("base64");
    if (Array.isArray(input))
      return input.map((entry, index) => redact(entry, "", `${path}[${index}]`));
    const record = asRecord(input);
    if (!record) {
      if (failClosed)
        throw new NativeTraceRedactionError(`Unsupported native trace value at ${path}`);
      unknownPaths.push(path);
      return "[REDACTED]";
    }
    const result: Record<string, unknown> = {};
    for (const childKey of Object.keys(record).sort()) {
      const childPath = path ? `${path}.${childKey}` : childKey;
      if (!allowedKeys.has(childKey) && !keyMatches(childKey, sensitiveKeys)) {
        unknownPaths.push(childPath);
        if (failClosed)
          throw new NativeTraceRedactionError(
            `Unknown native trace field ${childPath}`,
            unknownPaths,
          );
        result[childKey] = placeholder(String(record[childKey] ?? ""), preserve);
        continue;
      }
      result[childKey] = redact(record[childKey], childKey, childPath);
    }
    return result;
  };

  const scrubbed = redact(value, "", "");
  const leaks = scanNativeTraceLeaks(scrubbed, leakPatterns);
  if (leaks.length > 0)
    throw new NativeTraceRedactionError(
      `Native trace redaction leaked sensitive data: ${leaks.join(", ")}`,
    );
  const reportWithoutHash: Omit<NativeTraceRedactionReport, "reportHash"> = {
    version: NATIVE_TRACE_REDACTION_VERSION,
    reviewed: options.reviewed === true,
    leakScanPassed: true,
    failedClosed: unknownPaths.length > 0,
    redactedPaths: [...redactedPaths],
    unknownPaths: [...unknownPaths],
    sourceSha256: sha256NativeTraceValue(value),
    outputSha256: sha256NativeTraceValue(scrubbed),
  };
  return {
    value: scrubbed,
    report: { ...reportWithoutHash, reportHash: reportHash(reportWithoutHash) },
  };
}

export function redactNativeTraceValue(
  value: unknown,
  options: NativeTraceRedactionOptions = {},
): unknown {
  return redactNativeTrace(value, options).value;
}

export function normalizeNativeTrace(value: unknown): unknown {
  const ids = new Map<string, string>();
  const pathValues = new Map<string, string>();
  const placeholder = /^\[normalized:[^\]]+\]$/u;
  const idKey =
    /(?:(request|session|task|turn|item|tool(?:Call)?|run|event|parent)(?:_?id)$)|^id$/iu;
  const pathKey = /(?:cwd|path|file|directory|temp|home)$/iu;
  const timeKey =
    /(?:timestamp|startedAt|endedAt|createdAt|updatedAt|duration|elapsed|deadline|at)$/iu;
  const usageKey = /(?:usage|cost|tokens?|pid|process|hostname|memory|cpu)$/iu;
  const normalize = (input: unknown, key: string): unknown => {
    if (typeof input === "string") {
      if (placeholder.test(input)) return input;
      const idMatch = idKey.exec(key);
      if (idMatch) {
        const existing = ids.get(input);
        if (existing) return existing;
        const category = idMatch[1]?.toLowerCase() ?? "id";
        const replacement = `[normalized:${category}:${ids.size + 1}]`;
        ids.set(input, replacement);
        return replacement;
      }
      if (pathKey.test(key)) {
        const existing = pathValues.get(input);
        if (existing) return existing;
        const replacement = `[normalized:path:${pathValues.size + 1}]`;
        pathValues.set(input, replacement);
        return replacement;
      }
      if (timeKey.test(key)) return "[normalized:time]";
      if (usageKey.test(key)) return "[normalized:metadata]";
      return input;
    }
    if (typeof input === "number" && timeKey.test(key)) return "[normalized:time]";
    if (typeof input === "number" && usageKey.test(key)) return "[normalized:metadata]";
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number" ||
      input === undefined
    )
      return input;
    if (input instanceof Uint8Array) return new Uint8Array(input);
    if (Array.isArray(input)) return input.map((entry) => normalize(entry, ""));
    const record = asRecord(input);
    if (!record) return String(input);
    const result: Record<string, unknown> = {};
    for (const childKey of Object.keys(record).sort())
      result[childKey] = normalize(record[childKey], childKey);
    return result;
  };
  return normalize(value, "");
}

export const normalizeNativeTraceValue = normalizeNativeTrace;
export const normalizeNativeTraceFixture = normalizeNativeTrace;

export function createNativeTraceManifest(input: {
  readonly fixture: NativeTraceFixtureIdentity;
  readonly provenance: NativeTraceProvenance;
  readonly runtime: NativeTraceRuntime;
  readonly protocol: NativeTraceProtocol;
  readonly capabilities: NativeTraceCapabilities;
  readonly capture: NativeTraceCapture;
  readonly normalization?: NativeTraceNormalizationManifest;
  readonly redaction: NativeTraceRedactionManifest;
  readonly expectedOutcome: { readonly value: unknown };
  readonly compatibility?: NativeTraceCompatibility;
}): NativeTraceManifest {
  const normalization = input.normalization ?? {
    version: NATIVE_TRACE_NORMALIZATION_VERSION,
    strategy: "deterministic-structural-v1",
  };
  const compatibility = input.compatibility ?? {
    minSchemaVersion: NATIVE_TRACE_SCHEMA_VERSION,
    maxSchemaVersion: NATIVE_TRACE_SCHEMA_VERSION,
    runtimes: [input.runtime.kind],
  };
  const redactionSubject = {
    fixture: input.fixture,
    provenance: input.provenance,
    runtime: input.runtime,
    protocol: input.protocol,
    capabilities: input.capabilities,
    capture: input.capture,
    normalization,
    expectedOutcome: input.expectedOutcome.value,
    compatibility,
  };
  if (input.redaction.report.outputSha256 !== sha256NativeTraceValue(redactionSubject)) {
    throw new NativeTraceRedactionError(
      "Native trace redaction report does not cover the complete fixture subject.",
    );
  }
  const subjectLeaks = scanNativeTraceLeaks(redactionSubject);
  if (subjectLeaks.length > 0) {
    throw new NativeTraceRedactionError(
      `Native trace fixture still contains sensitive patterns: ${subjectLeaks.join(", ")}`,
    );
  }
  const captureByteLeaks = scanNativeTraceCaptureByteLeaks(input.capture);
  if (captureByteLeaks.length > 0) {
    throw new NativeTraceRedactionError(
      `Native trace capture bytes are not publication-safe: ${captureByteLeaks.join(", ")}`,
    );
  }
  const chunks = input.capture.chunks.map((chunk) => ({
    sequence: chunk.sequence,
    stream: chunk.stream,
    byteLength: chunk.byteLength,
    sha256: sha256NativeTraceBytes(decodeBase64(chunk.bytesBase64) ?? new Uint8Array()),
  }));
  const orderedBytes = concatNativeTraceBytes(
    [...input.capture.chunks]
      .sort((a, b) => a.sequence - b.sequence)
      .map((chunk) => decodeBase64(chunk.bytesBase64) ?? new Uint8Array()),
  );
  return {
    fixture: input.fixture,
    provenance: input.provenance,
    runtime: input.runtime,
    protocol: input.protocol,
    capabilities: input.capabilities,
    capture: {
      chunks,
      exits: input.capture.exits.map((exit) => ({ ...exit })),
      totalBytes: input.capture.totalBytes,
      totalEvents: input.capture.totalEvents,
      byteSha256: sha256NativeTraceBytes(orderedBytes),
      truncated: input.capture.truncated,
    },
    normalization,
    redaction: input.redaction,
    expectedOutcome: {
      value: input.expectedOutcome.value,
      fixtureId: input.fixture.id,
      sha256: sha256NativeTraceValue(input.expectedOutcome.value),
    },
    compatibility,
  };
}

export function createNativeTraceFixture(input: {
  readonly fixture: NativeTraceFixtureIdentity;
  readonly provenance: NativeTraceProvenance;
  readonly runtime: NativeTraceRuntime;
  readonly protocol: NativeTraceProtocol;
  readonly capabilities: NativeTraceCapabilities;
  readonly capture: NativeTraceCapture;
  readonly normalization?: NativeTraceNormalizationManifest;
  readonly redaction: NativeTraceRedactionManifest;
  readonly expectedOutcome: { readonly value: unknown };
  readonly compatibility?: NativeTraceCompatibility;
}): NativeTraceCaptureEnvelope {
  const manifest = createNativeTraceManifest(input);
  return validateNativeTraceFixture({
    schemaVersion: NATIVE_TRACE_SCHEMA_VERSION,
    kind: "native-trace",
    manifest,
    capture: input.capture,
  });
}
