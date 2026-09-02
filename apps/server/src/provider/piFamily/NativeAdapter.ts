// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import {
  ApprovalRequestId,
  CanonicalItemType,
  EventId,
  ProviderNativeSessionError,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  isToolLifecycleItemType,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderNativeSessionListInput,
  ProviderNativeSessionResumeCursor,
  type ProviderNativeSessionSummary,
  type ProviderRuntimeEventBase,
  type ProviderSendTurnInput,
  type ProviderSubagentTranscriptEntry,
  type ProviderSubagentTranscriptReadResult,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type {
  ProviderAdapterShape,
  ProviderNativeHistoryMessage,
  ProviderNativeHistoryPage,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OmpChunkAssembler } from "./OmpChunkAssembler.ts";
import { nativeEventId, PiFamilyEventProjector } from "./PiFamilyEventProjector.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";
import {
  absentRuntimeCapabilities,
  asRecord,
  asNumber,
  asString,
  isRpcResponse,
  makeOmpNegotiateProtocolCommand,
  negotiatedRuntimeCapabilities,
  parseJsonObject,
  validateOmpNegotiateProtocolResponse,
  validateOmpReadyFrame,
  type JsonRecord,
  type NativeCheckpoint,
  type PiFamilyProjectedEvent,
  type PiFamilyRuntimeKind,
  type RpcEnvelope,
  type RpcResponse,
  type RuntimeCapabilities,
} from "./protocol.ts";
import { piFamilyThinkingLevels, resolvePiFamilyLaunchArguments } from "./ModelDiscovery.ts";
import {
  listPiFamilyNativeSessions,
  readPiFamilyNativeHistoryMessages,
} from "./NativeSessionCatalog.ts";
import type { NativeTraceSink, NativeTraceSinkFactory } from "./NativeTrace.ts";
export interface PiFamilyNativeConfig {
  readonly provider: ProviderDriverKind;
  readonly runtime: PiFamilyRuntimeKind;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly agentDirectory?: string;
  readonly attachmentsDir?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launchArguments?: readonly string[];
  readonly trustMode?: string;
  readonly requestTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxMessageBytes: number;
  readonly stderrLimitBytes: number;
  readonly traceSinkFactory?: NativeTraceSinkFactory;
  readonly instanceId: ProviderInstanceId;
}
interface NativeSession {
  readonly threadId: ThreadId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly input: Queue.Queue<Uint8Array, never>;
  readonly scope: Scope.Closeable;
  readonly projector: PiFamilyEventProjector;
  readonly pending: Map<string, Pending>;
  readonly acceptedPromptIds: Set<string>;
  readonly uiRequestKinds: Map<string, "confirm" | "select" | "input" | "editor">;
  readonly activeTurns: Set<string>;
  readonly interruptedTurnIds: Set<string>;
  readonly activeTools: Set<string>;
  readonly activeTasks: Set<string>;
  readonly turns: ProviderThreadTurnSnapshot[];
  readonly startedAt: string;
  session: ProviderSession;
  readonly ready?: Deferred.Deferred<void, ProviderAdapterError>;
  readonly stopComplete: Deferred.Deferred<void, never>;
  readonly traceSink?: NativeTraceSink;
  readonly stdoutDrained: Deferred.Deferred<void, never>;
  readonly stderrDrained: Deferred.Deferred<void, never>;
  exitRecorded: boolean;
  traceInvalidated: boolean;
  traceFinalized: boolean;
  startupComplete: boolean;
  stopped: boolean;
  nativeSessionId?: string;
  nativeHistoryMessages?: ReadonlyArray<ProviderNativeHistoryMessage>;
  capabilities: RuntimeCapabilities;
  stderrBytes: Uint8Array;
  readonly eventOccurrenceBuckets: Float64Array;
}

interface Pending {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, ProviderAdapterRequestError>;
}

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const decodeText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value instanceof Uint8Array
      ? new TextDecoder().decode(value)
      : String(value);

function appendBoundedUtf8Tail(
  current: Uint8Array,
  chunk: Uint8Array,
  maxBytes: number,
): Uint8Array {
  if (maxBytes <= 0) return new Uint8Array();
  const currentBytesToKeep = Math.max(0, maxBytes - chunk.byteLength);
  const currentTail = current.subarray(Math.max(0, current.byteLength - currentBytesToKeep));
  const chunkTail = chunk.subarray(Math.max(0, chunk.byteLength - maxBytes));
  const combined = new Uint8Array(currentTail.byteLength + chunkTail.byteLength);
  combined.set(currentTail);
  combined.set(chunkTail, currentTail.byteLength);
  let start = Math.max(0, combined.byteLength - maxBytes);
  while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) start += 1;
  return combined.slice(start);
}

const OFFLINE_NATIVE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

let idCounter = 0;

const randomId = (): string =>
  `${DateTime.nowUnsafe().epochMilliseconds.toString(36)}-${(idCounter++).toString(36)}`;

const nowIso = (): string => DateTime.formatIso(DateTime.nowUnsafe());
function bindNativeSessionIdentity(
  session: NativeSession,
  runtime: PiFamilyRuntimeKind,
  sessionId: string,
  model: string | undefined,
  resetHistory: boolean,
): void {
  session.nativeSessionId = sessionId;
  if (resetHistory) delete session.nativeHistoryMessages;
  session.session = {
    ...session.session,
    ...(model === undefined ? {} : { model }),
    resumeCursor: {
      kind: "native-session",
      runtime,
      sessionId,
    },
    updatedAt: nowIso(),
  };
}
const NATIVE_INPUT_QUEUE_CAPACITY = 256;
const NATIVE_EVENT_QUEUE_CAPACITY = 4096;
const EVENT_OCCURRENCE_BUCKET_COUNT = 4_096;

function nextEventOccurrence(buckets: Float64Array, identity: string): number {
  let hash = 2_166_261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  const bucket = (hash >>> 0) % buckets.length;
  const occurrence = buckets[bucket]!;
  buckets[bucket] = occurrence + 1;
  return occurrence;
}

const nativeError = (
  provider: ProviderDriverKind,
  method: string,
  cause: unknown,
): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    reason: "native",
    cause,
  });

const processError = (
  provider: ProviderDriverKind,
  threadId: ThreadId,
  detail: string,
  cause?: unknown,
): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider,
    threadId,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isNativeSessionResumeCursor = Schema.is(ProviderNativeSessionResumeCursor);

function exitSignalFromCause(cause: unknown): string | null {
  const pending: unknown[] = [cause];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current instanceof Error) {
      const match = /receipt of signal: '([A-Z0-9]+)'/u.exec(current.message);
      if (match?.[1]) return match[1];
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if ("cause" in current) pending.push(current.cause);
    if ("reason" in current) pending.push(current.reason);
  }
  return null;
}
function nativeInputValue(answers: ProviderUserInputAnswers): string {
  const first = Object.values(answers)[0];
  if (typeof first === "string") return first;
  if (Array.isArray(first))
    return first.filter((value): value is string => typeof value === "string").join(", ");
  if (typeof first === "boolean" || typeof first === "number") return String(first);
  return first === undefined ? "" : JSON.stringify(first);
}

const MAX_TRANSCRIPT_ENTRY_CHARS = 65_536;

function boundedTranscriptText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_TRANSCRIPT_ENTRY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}\n…`;
}

function transcriptTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const text = boundedTranscriptText(content);
    return text === "" ? [] : [text];
  }
  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    const record = asRecord(part);
    const text =
      asString(record?.text) ??
      asString(record?.thinking) ??
      asString(record?.content) ??
      asString(record?.summary);
    if (text === undefined) return [];
    const bounded = boundedTranscriptText(text);
    return bounded === "" ? [] : [bounded];
  });
}

function transcriptEntriesFromResponse(
  response: RpcResponse,
): ProviderSubagentTranscriptReadResult | undefined {
  const data = asRecord(response.data);
  const nextByte = asNumber(data?.nextByte);
  if (nextByte === undefined || !Array.isArray(data?.entries)) return undefined;

  const transcriptEntries: ProviderSubagentTranscriptEntry[] = [];
  for (const [entryIndex, value] of data.entries.entries()) {
    const entry = asRecord(value);
    const message = asRecord(entry?.message);
    if (entry?.type !== "message" || message === undefined) continue;
    const baseId = asString(entry.id) ?? `message-${entryIndex}`;
    const candidateTimestamp = asString(entry.timestamp);
    const timestamp =
      candidateTimestamp !== undefined && !Number.isNaN(Date.parse(candidateTimestamp))
        ? candidateTimestamp
        : nowIso();
    const role = asString(message.role) ?? "system";
    const content = message.content;
    const parts = Array.isArray(content) ? content : [content];
    let emittedPart = 0;

    for (const part of parts) {
      const partRecord = asRecord(part);
      const partType = asString(partRecord?.type);
      const toolName =
        asString(partRecord?.name) ?? asString(partRecord?.toolName) ?? asString(message.toolName);
      if (role === "assistant" && (partType === "toolCall" || partType === "tool_call")) {
        const argumentsValue = partRecord?.arguments ?? partRecord?.input;
        const serializedArguments =
          argumentsValue === undefined ? undefined : JSON.stringify(argumentsValue, null, 2);
        const argumentsText =
          serializedArguments === undefined
            ? ""
            : `\n${boundedTranscriptText(serializedArguments)}`;
        transcriptEntries.push({
          id: `${baseId}:${emittedPart++}`,
          kind: "tool",
          text: `Called ${toolName ?? "tool"}${argumentsText}`,
          timestamp,
          ...(toolName === undefined ? {} : { toolName }),
        });
        continue;
      }
      const textParts = transcriptTextParts(part);
      for (const text of textParts) {
        const kind =
          role === "user"
            ? "user"
            : role === "assistant" && (partType === "thinking" || partType === "reasoning")
              ? "reasoning"
              : role === "assistant"
                ? "assistant"
                : role === "toolResult" || role === "tool"
                  ? "tool"
                  : "system";
        transcriptEntries.push({
          id: `${baseId}:${emittedPart++}`,
          kind,
          text,
          timestamp,
          ...(toolName === undefined ? {} : { toolName }),
          ...(kind === "tool" && message.isError === true ? { isError: true } : {}),
        });
      }
    }

    if (emittedPart > 0) continue;
    const summary =
      asString(message.summary) ?? asString(message.text) ?? asString(message.message);
    if (summary === undefined) continue;
    const text = boundedTranscriptText(summary);
    if (text === "") continue;
    transcriptEntries.push({
      id: `${baseId}:0`,
      kind: "system",
      text,
      timestamp,
    });
  }

  return {
    entries: transcriptEntries,
    nextCursor: String(Math.max(0, Math.trunc(nextByte))),
    reset: data?.reset === true,
  };
}

function canonicalToolItemType(raw: RpcEnvelope): CanonicalItemType {
  const explicit = asString(raw.itemType) ?? asString(raw.item_type);
  return explicit !== undefined && isToolLifecycleItemType(explicit)
    ? explicit
    : "dynamic_tool_call";
}
function nativePromptImages(
  input: ProviderSendTurnInput,
  attachmentsDir?: string,
): Effect.Effect<{
  readonly images: ReadonlyArray<JsonRecord>;
  readonly unavailable: ReadonlyArray<string>;
}> {
  return Effect.promise(async () => {
    const images: JsonRecord[] = [];
    const unavailable: string[] = [];
    for (const attachment of input.attachments ?? []) {
      const record = asRecord(attachment);
      if (!record || record.type !== "image") continue;
      const mimeType = asString(record.mimeType);
      const dataUrl = asString(record.dataUrl);
      const rawData = asString(record.data);
      let data = rawData ?? dataUrl?.match(/^data:[^;]+;base64,(.+)$/i)?.[1];
      if (!data && attachmentsDir && mimeType) {
        try {
          const path = resolveAttachmentPath({
            attachmentsDir,
            attachment: record as never,
          });
          if (path) data = (await NodeFS.promises.readFile(path)).toString("base64");
        } catch {
          // Report a precise unsupported result below; never send metadata only.
        }
      }
      if (!data || !mimeType) unavailable.push(asString(record.name) ?? "unnamed image");
      else images.push({ type: "image", data, mimeType });
    }
    return { images, unavailable };
  });
}

const MAX_PERSISTED_NATIVE_EVENT_BYTES = 8 * 1024;
const MAX_PERSISTED_NATIVE_EVENT_DEPTH = 5;
const MAX_PERSISTED_NATIVE_EVENT_ENTRIES = 64;
const MAX_PERSISTED_NATIVE_EVENT_STRING = 512;
const REDACTED_NATIVE_EVENT_KEY =
  /authorization|cookie|credential|password|secret|token|api[-_]?key|signature|encrypted|prompt|content|text|message|delta|args|result|data|payload|input|output|query|description|command|email|username|home|cwd|path|environment|env|usage|cost|timestamp|startedAt|endedAt|createdAt|updatedAt|pid|process/i;

function redactNativeEventValue(value: unknown, key: string, depth: number): unknown {
  if (REDACTED_NATIVE_EVENT_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return value.slice(0, MAX_PERSISTED_NATIVE_EVENT_STRING);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (depth >= MAX_PERSISTED_NATIVE_EVENT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PERSISTED_NATIVE_EVENT_ENTRIES)
      .map((entry) => redactNativeEventValue(entry, "", depth + 1));
  }
  const record = asRecord(value);
  if (!record) return String(value);
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, MAX_PERSISTED_NATIVE_EVENT_ENTRIES)
      .map(([childKey, childValue]) => [
        childKey,
        redactNativeEventValue(childValue, childKey, depth + 1),
      ]),
  );
}

function persistedNativeEnvelope(event: RpcEnvelope): JsonRecord {
  const sanitized = asRecord(redactNativeEventValue(event, "", 0)) ?? {
    type: event.type.slice(0, MAX_PERSISTED_NATIVE_EVENT_STRING),
  };
  const byteLength = new TextEncoder().encode(JSON.stringify(sanitized)).byteLength;
  if (byteLength <= MAX_PERSISTED_NATIVE_EVENT_BYTES) return sanitized;
  const boundedMetadata = (value: unknown): string | undefined =>
    asString(value)?.slice(0, MAX_PERSISTED_NATIVE_EVENT_STRING);
  const type = boundedMetadata(event.type) ?? "unknown";
  const id = boundedMetadata(event.id);
  const requestId = boundedMetadata(event.requestId);
  const taskId = boundedMetadata(event.taskId);
  return {
    type,
    ...(id === undefined ? {} : { id }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(taskId === undefined ? {} : { taskId }),
    truncated: true,
    originalByteLength: byteLength,
  };
}

function checkpointDescriptor(
  runtime: PiFamilyRuntimeKind,
  runtimeVersion: string | undefined,
  data: unknown,
): NativeCheckpoint | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  const sessionId = asString(record.sessionId);
  const leafEntryId =
    runtime === "omp" ? asString(record.checkpointId) : asString(record.leafEntryId);
  if (!sessionId || !leafEntryId) return undefined;
  return {
    runtime,
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    sessionId,
    leafEntryId,
    opaque: data,
  };
}

function readCheckpointDescriptor(value: unknown): NativeCheckpoint | undefined {
  const record = asRecord(value);
  const runtime = asString(record?.runtime);
  const sessionId = asString(record?.sessionId);
  const leafEntryId = asString(record?.leafEntryId);
  const runtimeVersion = asString(record?.runtimeVersion);
  if ((runtime !== "pi" && runtime !== "omp") || !sessionId || !leafEntryId) return undefined;
  return {
    runtime,
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    sessionId,
    leafEntryId,
    opaque: record?.opaque,
  };
}
function readNativeSessionResumeCursor(
  value: unknown,
): ProviderNativeSessionResumeCursor | undefined {
  return isNativeSessionResumeCursor(value) ? value : undefined;
}

function withoutSessionSelectionArguments(arguments_: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (
      argument === "--resume" ||
      argument === "-r" ||
      argument === "--session" ||
      argument === "--session-id" ||
      argument === "--fork"
    ) {
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--resume=") ||
      argument.startsWith("-r=") ||
      argument.startsWith("--session=") ||
      argument.startsWith("--session-id=") ||
      argument.startsWith("--fork=")
    ) {
      continue;
    }
    if (argument === "--continue" || argument === "-c") continue;
    filtered.push(argument);
  }
  return filtered;
}

function nativeModelSlug(value: unknown): string | undefined {
  const model = asRecord(value);
  const id = asString(model?.id);
  if (id === undefined) return undefined;
  const provider = asString(model?.provider);
  return provider === undefined || id.includes("/") ? id : `${provider}/${id}`;
}

function canonicalTaskRunHandles(
  handles: Readonly<Record<string, unknown>> | undefined,
): JsonRecord | undefined {
  if (!handles) return undefined;
  const runId = asString(handles.runId) ?? asString(handles.jobId);
  const scriptPath = asString(handles.scriptPath) ?? asString(handles.outputPath);
  const transcriptDir = asString(handles.transcriptDir) ?? asString(handles.transcript);
  const sessionUrl = asString(handles.sessionUrl);
  const result = {
    ...(runId === undefined ? {} : { runId }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(transcriptDir === undefined ? {} : { transcriptDir }),
    ...(sessionUrl?.startsWith("http://") || sessionUrl?.startsWith("https://")
      ? { sessionUrl }
      : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}
function assistantMessageFields(raw: RpcEnvelope): {
  readonly itemId?: string;
  readonly detail?: string;
} {
  const message = asRecord(raw.message) ?? asRecord(raw.assistantMessage) ?? asRecord(raw.data);
  const messageId =
    asString(message?.id) ??
    asString(message?.messageId) ??
    asString(raw.messageId) ??
    asString(raw.id);
  const content = message?.content;
  let detail =
    asString(message?.text) ??
    (typeof content === "string" ? content : undefined) ??
    asString(raw.text);
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const record = asRecord(part);
        return (
          asString(record?.text) ?? (record?.type === "text" ? asString(record.content) : undefined)
        );
      })
      .filter((part): part is string => part !== undefined)
      .join("");
    if (text.length > 0) detail = text;
  }
  const trimmed = detail?.trim();
  return {
    ...(messageId === undefined ? {} : { itemId: messageId }),
    ...(trimmed ? { detail: trimmed } : {}),
  };
}

function rawSource(runtime: PiFamilyRuntimeKind): "pi.rpc" | "omp.rpc" {
  return runtime === "pi" ? "pi.rpc" : "omp.rpc";
}

function rawEvent(runtime: PiFamilyRuntimeKind, event: unknown) {
  return { source: rawSource(runtime), payload: event } as const;
}

function makeBase(
  config: PiFamilyNativeConfig,
  threadId: ThreadId,
  event: unknown,
  discriminator: string | undefined,
  eventOccurrence: number,
  persistRaw = true,
): ProviderRuntimeEventBase {
  const record = asRecord(event);
  const isNativeEnvelope = record !== undefined && typeof record.type === "string";
  const eventId = isNativeEnvelope
    ? `${config.instanceId}:${threadId}:${nativeEventId(config.runtime, record as RpcEnvelope, eventOccurrence)}${discriminator ? `:${discriminator}` : ""}`
    : randomId();
  return {
    eventId: EventId.make(eventId),
    provider: config.provider,
    providerInstanceId: config.instanceId,
    threadId,
    createdAt: nowIso(),
    ...(event === undefined || !persistRaw
      ? {}
      : {
          raw: rawEvent(
            config.runtime,
            isNativeEnvelope ? persistedNativeEnvelope(record as RpcEnvelope) : event,
          ),
        }),
  };
}
function projectionIdentityEvent(projected: PiFamilyProjectedEvent): RpcEnvelope | undefined {
  if (projected.kind === "runtime.raw") return projected.event;
  if (projected.kind === "runtime.ready") return projected.ready;
  if (projected.kind === "runtime.error") {
    const raw = asRecord(projected.raw);
    return raw !== undefined && typeof raw.type === "string" ? (raw as RpcEnvelope) : undefined;
  }
  if ("raw" in projected) return projected.raw;
  return undefined;
}

function eventForProjection(
  config: PiFamilyNativeConfig,
  threadId: ThreadId,
  projected: PiFamilyProjectedEvent,
  interruptedTurnIds: ReadonlySet<string>,
  eventOccurrence: number,
): ProviderRuntimeEvent | undefined {
  if (projected.kind === "runtime.raw") return undefined;

  const raw = projectionIdentityEvent(projected);
  const discriminator =
    projected.kind === "task.started" ||
    projected.kind === "task.progress" ||
    projected.kind === "task.completed"
      ? `task:${projected.task.id}`
      : projected.kind === "tool.started" ||
          projected.kind === "tool.progress" ||
          projected.kind === "tool.completed"
        ? `tool:${projected.toolCallId ?? "anonymous"}:${projected.kind}`
        : projected.kind === "ui.request"
          ? `ui:${projected.request.requestId ?? "anonymous"}`
          : projected.kind;
  const base = makeBase(config, threadId, raw, discriminator, eventOccurrence, true);
  switch (projected.kind) {
    case "runtime.ready":
      return {
        ...base,
        type: "session.configured",
        payload: { config: projected.ready },
      };
    case "runtime.exit":
      return {
        ...base,
        type: "session.exited",
        payload: {
          ...(projected.stderr ? { reason: "Native runtime emitted diagnostics on stderr." } : {}),
          exitKind: projected.code === 0 ? "graceful" : "error",
          recoverable: false,
        },
      };
    case "runtime.error":
      return {
        ...base,
        type: "runtime.error",
        payload: {
          message: projected.error.message || "Native runtime error",
          class: "transport_error",
          ...(projected.raw === undefined ? {} : { detail: projected.raw }),
        },
      };
    case "turn.started":
      return {
        ...base,
        type: "turn.started",
        ...(projected.requestId ? { turnId: TurnId.make(projected.requestId) } : {}),
        payload: {},
      };
    case "turn.settled": {
      const settled = asRecord(projected.raw);
      const settledMessage =
        asRecord(settled?.message) ??
        asRecord(settled?.assistantMessage) ??
        asRecord(settled?.data);
      const candidate =
        asString(settled?.status) ??
        asString(settled?.state) ??
        asString(settled?.stopReason) ??
        asString(settled?.stop_reason) ??
        asString(settledMessage?.stopReason) ??
        asString(settledMessage?.stop_reason);
      const wasInterrupted =
        projected.requestId !== undefined && interruptedTurnIds.has(projected.requestId);
      const state =
        settled?.success === false || candidate === "failed" || candidate === "error"
          ? "failed"
          : wasInterrupted ||
              candidate === "interrupted" ||
              candidate === "cancelled" ||
              candidate === "canceled" ||
              candidate === "aborted"
            ? "interrupted"
            : "completed";
      return {
        ...base,
        type: "turn.completed",
        ...(projected.requestId ? { turnId: TurnId.make(projected.requestId) } : {}),
        payload: { state },
      };
    }
    case "message.delta":
      return {
        ...base,
        type: "content.delta",
        payload: {
          streamKind: projected.channel === "reasoning" ? "reasoning_text" : "assistant_text",
          delta: projected.text,
        },
      };
    case "tool.started":
    case "tool.progress":
    case "tool.completed": {
      const toolId = projected.toolCallId;
      const title = projected.name?.trim() || "Native tool";
      const status =
        projected.kind === "tool.started"
          ? "inProgress"
          : projected.kind === "tool.completed"
            ? "completed"
            : "inProgress";
      return {
        ...base,
        type:
          projected.kind === "tool.started"
            ? "item.started"
            : projected.kind === "tool.progress"
              ? "item.updated"
              : "item.completed",
        ...(toolId === undefined ? {} : { itemId: RuntimeItemId.make(toolId) }),
        payload: {
          itemType: canonicalToolItemType(projected.raw),
          status,
          title,
          data: projected.raw,
        },
      };
    }
    case "message.completed": {
      const message = assistantMessageFields(projected.raw);
      return {
        ...base,
        type: "item.completed",
        ...(message.itemId === undefined ? {} : { itemId: RuntimeItemId.make(message.itemId) }),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(message.detail === undefined ? {} : { detail: message.detail }),
          data: persistedNativeEnvelope(projected.raw),
        },
      };
    }
    case "task.started":
    case "task.progress":
    case "task.completed": {
      const taskId = RuntimeTaskId.make(projected.task.id);
      const description = projected.task.description ?? projected.task.title ?? projected.task.id;
      const linkage = {
        taskType: projected.task.kind,
        ...(projected.task.title ? { title: projected.task.title } : {}),
        ...(projected.task.role ? { role: projected.task.role } : {}),
        ...(projected.task.model ? { model: projected.task.model } : {}),
        ...(projected.task.parentToolCallId ? { toolUseId: projected.task.parentToolCallId } : {}),
        ...(projected.task.parentTaskId ? { parentAgentId: projected.task.parentTaskId } : {}),
        ...(projected.task.detached === undefined
          ? {}
          : { isBackgrounded: projected.task.detached }),
        ...(projected.task.workflow?.name ? { workflowName: projected.task.workflow.name } : {}),
        ...(projected.task.workflow?.phaseIndex === undefined
          ? {}
          : { phaseIndex: projected.task.workflow.phaseIndex }),
        ...(projected.task.workflow?.phaseTitle
          ? { phaseTitle: projected.task.workflow.phaseTitle }
          : {}),
        ...(projected.task.workflow?.agentIndex === undefined
          ? {}
          : { agentIndex: projected.task.workflow.agentIndex }),
        ...(projected.task.attempt === undefined ? {} : { attempt: projected.task.attempt }),
        ...(canonicalTaskRunHandles(projected.task.runHandles)
          ? { runHandles: canonicalTaskRunHandles(projected.task.runHandles) }
          : {}),
      };
      if (projected.kind === "task.started") {
        return {
          ...base,
          type: "task.started",
          payload: { taskId, description, ...linkage },
        };
      }
      if (projected.kind === "task.progress") {
        return {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description,
            ...linkage,
            ...(projected.task.summary ? { summary: projected.task.summary } : {}),
            ...(projected.task.status ? { status: projected.task.status } : {}),
            ...(projected.task.error ? { error: projected.task.error } : {}),
            ...(projected.task.lastToolName ? { lastToolName: projected.task.lastToolName } : {}),
            ...(projected.task.usage ? { usage: projected.task.usage } : {}),
          },
        };
      }
      return {
        ...base,
        type: "task.completed",
        payload: {
          taskId,
          ...linkage,
          status:
            projected.task.status === "failed"
              ? "failed"
              : projected.task.status === "cancelled" || projected.task.status === "interrupted"
                ? "stopped"
                : "completed",
          ...(projected.task.summary ? { summary: projected.task.summary } : {}),
          ...(projected.task.usage ? { usage: projected.task.usage } : {}),
        },
      };
    }
    case "plan.updated":
      return {
        ...base,
        type: "turn.plan.updated",
        ...(projected.requestId ? { turnId: TurnId.make(projected.requestId) } : {}),
        payload: { plan: [...projected.plan] },
      };
    case "ui.request": {
      const request = projected.request;
      if (request.kind === "status") {
        return {
          ...base,
          type: "ui.status.updated",
          payload: {
            key: request.key,
            ...(request.value === undefined ? {} : { value: request.value }),
          },
        };
      }
      if (request.kind === "widget") {
        return {
          ...base,
          type: "ui.widget.updated",
          payload: {
            key: request.key,
            placement: request.placement ?? "above",
            ...(request.content === undefined ? {} : { content: request.content }),
          },
        };
      }
      const requestId = RuntimeRequestId.make(request.requestId ?? randomId());
      if (request.kind === "select") {
        return {
          ...base,
          type: "user-input.requested",
          requestId,
          payload: {
            questions: [
              {
                id: requestId,
                header: request.title ?? "Select",
                question: request.message ?? request.title ?? "Select an option",
                options: request.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? option.label,
                })),
              },
            ],
          },
        };
      }
      if (request.kind === "confirm" || request.kind === "input" || request.kind === "editor") {
        return {
          ...base,
          type: "request.opened",
          requestId,
          payload: {
            requestType:
              request.kind === "confirm" ? "command_execution_approval" : "tool_user_input",
            ...(request.message ? { detail: request.message } : {}),
            args: request,
          },
        };
      }
      return {
        ...base,
        type: "runtime.warning",
        payload: {
          message:
            request.kind === "unsupported_terminal_ui"
              ? `${request.message}. Open the native ${config.runtime.toUpperCase()} terminal for this thread to continue.`
              : `Native UI request: ${request.kind}`,
          detail: request,
          ...(request.kind === "unsupported_terminal_ui"
            ? {
                nativeTerminalFallback: {
                  runtime: config.runtime,
                  providerInstanceId: config.instanceId,
                  feature: request.feature,
                },
              }
            : {}),
        },
      };
    }
    case "compaction.completed":
      return {
        ...base,
        type: "thread.state.changed",
        payload: {
          state: "compacted",
          detail: persistedNativeEnvelope(projected.raw),
        },
      };
    case "queue.changed":
    case "compaction.started":
    case "retry.scheduled":
      return {
        ...base,
        type: "runtime.warning",
        payload: { message: `Native runtime state: ${projected.kind}`, detail: projected.raw },
      };
  }
  return {
    ...base,
    type: "runtime.warning",
    payload: { message: `Native ${config.runtime} event`, detail: projected },
  };
}

function capabilitiesFrom(
  runtime: PiFamilyRuntimeKind,
  value: unknown,
  ready?: {
    protocolVersion: 1 | 2;
    supportedProtocolVersions: readonly (1 | 2)[];
    maxFrameBytes?: number;
    maxReassembledFrameBytes?: number;
  },
): RuntimeCapabilities {
  const record = asRecord(value);
  const protocolVersion = record?.protocolVersion === 2 || ready?.protocolVersion === 2 ? 2 : 1;
  const base = negotiatedRuntimeCapabilities(runtime, protocolVersion);
  const transport = asRecord(record?.transport);
  const models = asRecord(record?.models);
  const thinking = asRecord(record?.thinking);
  const commands = asRecord(record?.commands);
  const sessions = asRecord(record?.sessions);
  const ui = asRecord(record?.ui);
  const tasks = asRecord(record?.tasks);
  const bool = (source: JsonRecord | undefined, key: string, fallback: boolean): boolean =>
    typeof source?.[key] === "boolean" ? (source[key] as boolean) : fallback;
  const number = (source: JsonRecord | undefined, key: string): number | undefined =>
    typeof source?.[key] === "number" && Number.isFinite(source[key])
      ? (source[key] as number)
      : undefined;
  const maxFrameBytes = number(transport, "maxFrameBytes") ?? ready?.maxFrameBytes;
  const maxReassembledFrameBytes =
    number(transport, "maxReassembledFrameBytes") ?? ready?.maxReassembledFrameBytes;
  const supported = Array.isArray(record?.supportedProtocolVersions)
    ? record.supportedProtocolVersions.filter(
        (version): version is 1 | 2 => version === 1 || version === 2,
      )
    : (ready?.supportedProtocolVersions ?? base.supportedProtocolVersions);
  const negotiatedProtocolVersion =
    record?.negotiatedProtocolVersion === 2 || protocolVersion === 2 ? 2 : undefined;
  return {
    ...base,
    ...(typeof record?.runtimeVersion === "string"
      ? { runtimeVersion: record.runtimeVersion }
      : {}),
    protocolVersion,
    supportedProtocolVersions: supported.length > 0 ? supported : base.supportedProtocolVersions,
    ...(negotiatedProtocolVersion === 2 ? { negotiatedProtocolVersion: 2 } : {}),
    transport: {
      ...base.transport,
      ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
      ...(maxReassembledFrameBytes === undefined ? {} : { maxReassembledFrameBytes }),
      chunking: bool(transport, "chunking", base.transport.chunking),
    },
    models: {
      discover: bool(models, "discover", base.models.discover),
      switch: bool(models, "switch", base.models.switch),
    },
    thinking: {
      discover: bool(thinking, "discover", base.thinking.discover),
      switch: bool(thinking, "switch", base.thinking.switch),
    },
    commands: {
      discover: bool(commands, "discover", base.commands.discover),
      invokeNative: bool(commands, "invokeNative", base.commands.invokeNative),
    },
    sessions: {
      resume: bool(sessions, "resume", base.sessions.resume),
      tree: bool(sessions, "tree", base.sessions.tree),
      fork: bool(sessions, "fork", base.sessions.fork),
      compact: bool(sessions, "compact", base.sessions.compact),
      nativeCheckpoint: bool(sessions, "nativeCheckpoint", base.sessions.nativeCheckpoint),
      completeTurnRollback: bool(
        sessions,
        "completeTurnRollback",
        base.sessions.completeTurnRollback,
      ),
    },
    ui: {
      select: bool(ui, "select", base.ui.select),
      confirm: bool(ui, "confirm", base.ui.confirm),
      input: bool(ui, "input", base.ui.input),
      editor: bool(ui, "editor", base.ui.editor),
      notify: bool(ui, "notify", base.ui.notify),
      status: bool(ui, "status", base.ui.status),
      widget: bool(ui, "widget", base.ui.widget),
      openUrl: bool(ui, "openUrl", base.ui.openUrl),
      arbitraryTerminalComponents: false,
    },
    tasks: {
      lifecycle: bool(tasks, "lifecycle", base.tasks.lifecycle),
      nested: bool(tasks, "nested", base.tasks.nested),
      childTranscript: bool(tasks, "childTranscript", base.tasks.childTranscript),
      workflows: bool(tasks, "workflows", base.tasks.workflows),
      background: bool(tasks, "background", base.tasks.background),
      targetedCancellation: bool(tasks, "targetedCancellation", base.tasks.targetedCancellation),
    },
    ...(record ? { raw: record } : {}),
  };
}

export const makePiFamilyAdapter = (
  config: PiFamilyNativeConfig,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* Queue.bounded<ProviderRuntimeEvent>(NATIVE_EVENT_QUEUE_CAPACITY);
    const sessions = new Map<ThreadId, NativeSession>();
    const adapterCapabilities = {
      get sessionModelSwitch(): "in-session" | "unsupported" {
        const activeSessions = [...sessions.values()].filter((session) => !session.stopped);
        return activeSessions.length > 0 &&
          activeSessions.every((session) => session.capabilities.models.switch)
          ? "in-session"
          : "unsupported";
      },
    };

    const offer = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      // Queue.bounded uses the suspending strategy: a full queue backpressures
      // the native reader. `false` means the queue is already closing, not that
      // a live-session event was dropped at capacity.
      Queue.offer(events, event).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.logWarning("provider.pi-family.event-queue-closed", {
                provider: config.provider,
                threadId: event.threadId,
                eventType: event.type,
              }),
        ),
      );
    const offerProjection = (
      session: NativeSession,
      projection: PiFamilyProjectedEvent,
    ): Effect.Effect<void> => {
      const identityEvent = projectionIdentityEvent(projection);
      const nativeIdentity =
        identityEvent === undefined
          ? projection.kind
          : nativeEventId(config.runtime, identityEvent);
      const identityKey = `${nativeIdentity}:${projection.kind}`;
      const eventOccurrence = nextEventOccurrence(session.eventOccurrenceBuckets, identityKey);
      const event = eventForProjection(
        config,
        session.threadId,
        projection,
        session.interruptedTurnIds,
        eventOccurrence,
      );
      if (projection.kind === "turn.settled" && projection.requestId !== undefined) {
        session.interruptedTurnIds.delete(projection.requestId);
      }
      return event === undefined ? Effect.void : offer(event);
    };
    const failPending = (
      session: NativeSession,
      error: ProviderAdapterRequestError,
    ): Effect.Effect<void> =>
      Effect.forEach(
        [...session.pending.values()],
        (pending) => Deferred.fail(pending.deferred, error).pipe(Effect.ignore),
        {
          discard: true,
        },
      );

    const recordBytes = (
      session: NativeSession,
      stream: "stdin" | "stdout" | "stderr",
      bytes: Uint8Array,
    ): Effect.Effect<void, ProviderAdapterProcessError> => {
      const traceSink = session.traceSink;
      if (traceSink === undefined) return Effect.void;
      return Effect.try({
        try: () => {
          if (session.traceInvalidated || session.traceFinalized) return;
          traceSink.recordBytes(stream, new Uint8Array(bytes));
        },
        catch: () =>
          processError(
            config.provider,
            session.threadId,
            `Native trace sink failed while recording ${stream}.`,
          ),
      });
    };

    const recordExit = (
      session: NativeSession,
      code: number | null,
      signal: string | null,
    ): Effect.Effect<void, ProviderAdapterProcessError> => {
      const traceSink = session.traceSink;
      if (traceSink === undefined) return Effect.void;
      return Effect.try({
        try: () => {
          if (session.traceInvalidated || session.traceFinalized || session.exitRecorded) return;
          session.exitRecorded = true;
          traceSink.recordExit(code, signal);
        },
        catch: () =>
          processError(
            config.provider,
            session.threadId,
            "Native trace sink failed while recording process exit.",
          ),
      });
    };

    const finalizeTrace = (
      session: NativeSession,
    ): Effect.Effect<void, ProviderAdapterProcessError> => {
      const traceSink = session.traceSink;
      if (
        traceSink === undefined ||
        traceSink.finalize === undefined ||
        session.traceFinalized ||
        session.traceInvalidated
      ) {
        return Effect.void;
      }
      session.traceFinalized = true;
      return Effect.try({
        try: () => traceSink.finalize?.(),
        catch: () =>
          processError(
            config.provider,
            session.threadId,
            "Native trace sink failed while finalizing the session.",
          ),
      });
    };

    const reportTraceFailure = (
      session: NativeSession,
      failure: ProviderAdapterProcessError,
    ): Effect.Effect<void> =>
      offerProjection(session, {
        kind: "runtime.error",
        error: failure,
      });

    const invalidateTrace = (session: NativeSession): Effect.Effect<void> => {
      if (session.traceInvalidated) return Effect.void;
      session.traceInvalidated = true;
      return Effect.try({
        try: () => session.traceSink?.invalidate(),
        catch: (cause) =>
          processError(
            config.provider,
            session.threadId,
            "Native trace sink failed while invalidating an incomplete capture.",
            cause,
          ),
      }).pipe(Effect.catch((failure) => reportTraceFailure(session, failure)));
    };

    const awaitTraceDrain = (session: NativeSession): Effect.Effect<boolean> =>
      Effect.all([Deferred.await(session.stdoutDrained), Deferred.await(session.stderrDrained)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.timeout("3 seconds"),
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );

    const stopSession = (
      threadId: ThreadId,
      closeScope = true,
      awaitDrain = true,
      cancelTasks = true,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) return;
        if (session.stopped) {
          yield* Deferred.await(session.stopComplete);
          return;
        }
        session.stopped = true;
        session.interruptedTurnIds.clear();
        const cancellableTasks =
          cancelTasks && config.runtime === "omp"
            ? session.projector.snapshotTasks().flatMap((task) => {
                const runId = task.runHandles?.runId;
                return task.detached === true &&
                  task.status !== "completed" &&
                  task.status !== "failed" &&
                  task.status !== "cancelled" &&
                  task.status !== "interrupted" &&
                  typeof runId === "string"
                  ? [{ taskId: task.id, runId }]
                  : [];
              })
            : [];
        const acknowledgedTaskIds = (yield* Effect.forEach(
          cancellableTasks,
          (task) =>
            request(
              session,
              {
                type: "cancel_task",
                taskId: task.taskId,
                runId: task.runId,
              },
              "cancel_task",
              1_500,
            ).pipe(
              Effect.interruptible,
              Effect.timeout("2 seconds"),
              Effect.as(task.taskId),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          { concurrency: 1 },
        )).filter((taskId): taskId is string => taskId !== undefined);
        if (acknowledgedTaskIds.length > 0) {
          const acknowledged = new Set(acknowledgedTaskIds);
          const snapshots = session.projector.snapshotTasks();
          const byId = new Map(snapshots.map((task) => [task.id, task]));
          const belongsToAcknowledgedTask = (taskId: string): boolean => {
            let current = byId.get(taskId);
            const visited = new Set<string>();
            while (current !== undefined && !visited.has(current.id)) {
              if (acknowledged.has(current.id)) return true;
              visited.add(current.id);
              current =
                current.parentTaskId === undefined ? undefined : byId.get(current.parentTaskId);
            }
            return false;
          };
          const unsettled = snapshots
            .filter(
              (task) =>
                belongsToAcknowledgedTask(task.id) &&
                task.status !== "completed" &&
                task.status !== "failed" &&
                task.status !== "cancelled" &&
                task.status !== "interrupted",
            )
            .toReversed();
          yield* Effect.forEach(
            unsettled,
            (task) =>
              Effect.forEach(
                session.projector.project({
                  type: "subagent_lifecycle",
                  payload: {
                    id: task.id,
                    status: "aborted",
                    ...(task.parentTaskId === undefined ? {} : { parentId: task.parentTaskId }),
                    ...(task.parentToolCallId === undefined
                      ? {}
                      : { parentToolCallId: task.parentToolCallId }),
                    ...(task.detached === undefined ? {} : { detached: task.detached }),
                  },
                }),
                (projection) => offerProjection(session, projection),
                { discard: true },
              ),
            { concurrency: 1, discard: true },
          );
        }
        const error = nativeError(config.provider, "session", "Native session stopped");
        if (session.ready !== undefined) {
          yield* Deferred.fail(session.ready, error).pipe(Effect.ignore);
        }
        yield* failPending(session, error);
        yield* Queue.shutdown(session.input);
        yield* session.child
          .kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" })
          .pipe(Effect.ignore);
        const observedExit = yield* Effect.exit(
          session.child.exitCode.pipe(Effect.timeout("3 seconds")),
        );
        const streamsDrained = !awaitDrain || (yield* awaitTraceDrain(session));
        if (session.traceSink !== undefined) {
          const traceExit = Exit.isSuccess(observedExit)
            ? { code: Number(observedExit.value), signal: null }
            : {
                code: null,
                signal: exitSignalFromCause(Cause.squash(observedExit.cause)),
              };
          const exitObserved = Exit.isSuccess(observedExit) || traceExit.signal !== null;
          if (!session.startupComplete) yield* invalidateTrace(session);
          let captureComplete =
            exitObserved && session.startupComplete && !session.traceInvalidated;
          if (captureComplete && !streamsDrained) {
            captureComplete = false;
            yield* invalidateTrace(session);
            yield* reportTraceFailure(
              session,
              processError(
                config.provider,
                session.threadId,
                "Native trace output streams did not drain before the lifecycle deadline.",
              ),
            );
          }
          if (!exitObserved) {
            yield* invalidateTrace(session);
            yield* reportTraceFailure(
              session,
              processError(
                config.provider,
                session.threadId,
                "Native process termination signal could not be observed before the lifecycle deadline.",
                Exit.isFailure(observedExit) ? observedExit.cause : undefined,
              ),
            );
          } else if (captureComplete) {
            yield* recordExit(session, traceExit.code, traceExit.signal).pipe(
              Effect.catch((failure) =>
                invalidateTrace(session).pipe(Effect.andThen(reportTraceFailure(session, failure))),
              ),
            );
          }
          if (!session.traceInvalidated) {
            yield* finalizeTrace(session).pipe(
              Effect.catch((failure) => reportTraceFailure(session, failure)),
            );
          }
        }
        if (closeScope) {
          yield* Effect.forkDetach(
            Scope.close(session.scope, Exit.succeed(undefined)).pipe(Effect.ignore),
          );
        }
        if (sessions.get(threadId) === session) sessions.delete(threadId);
        yield* Deferred.succeed(session.stopComplete, undefined).pipe(Effect.ignore);
      }).pipe(Effect.uninterruptible);
    const failSession = (
      session: NativeSession,
      failure: ProviderAdapterProcessError,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (session.stopped) return;
        yield* invalidateTrace(session);
        yield* reportTraceFailure(session, failure);
        yield* stopSession(session.threadId, false, false, false);
        yield* Effect.forkDetach(
          Scope.close(session.scope, Exit.succeed(undefined)).pipe(Effect.ignore),
        );
      });

    const stopAll = (): Effect.Effect<void> =>
      Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
        discard: true,
      }).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<NativeSession, ProviderAdapterSessionNotFoundError> => {
      const session = sessions.get(threadId);
      return session && !session.stopped
        ? Effect.succeed(session)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: config.provider, threadId }),
          );
    };
    const isQuiescent = (session: NativeSession): boolean =>
      session.pending.size === 0 &&
      session.uiRequestKinds.size === 0 &&
      session.activeTurns.size === 0 &&
      session.activeTools.size === 0 &&
      session.activeTasks.size === 0;

    const send = (
      session: NativeSession,
      envelope: RpcEnvelope,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const bytes = encode(envelope);
        const accepted = yield* Queue.offer(session.input, bytes);
        if (!accepted) {
          return yield* Effect.fail(
            nativeError(config.provider, envelope.type, "Native session input is closed"),
          );
        }
      });

    const request = (
      session: NativeSession,
      envelope: JsonRecord,
      method: string,
      timeoutMs = config.requestTimeoutMs,
    ): Effect.Effect<RpcResponse, ProviderAdapterRequestError> => {
      const id = asString(envelope.id) ?? randomId();
      const requestEnvelope = { ...envelope, id, type: String(envelope.type) } as RpcEnvelope;
      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<RpcResponse, ProviderAdapterRequestError>();
        session.pending.set(id, { command: requestEnvelope.type, deferred });
        yield* send(session, requestEnvelope);
        return yield* Deferred.await(deferred).pipe(
          Effect.timeout(timeoutMs),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: config.provider,
                method,
                detail: `RPC timed out after ${timeoutMs}ms`,
                reason: "timeout",
              }),
            ),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            session.pending.delete(id);
          }),
        ),
      );
    };

    const inferTurnRequestId = (session: NativeSession): string | undefined => {
      let candidate: string | undefined;
      for (const requestId of session.activeTurns) {
        if (requestId === "__anonymous__") continue;
        if (candidate !== undefined && candidate !== requestId) return undefined;
        candidate = requestId;
      }
      for (const requestId of session.acceptedPromptIds) {
        if (candidate !== undefined && candidate !== requestId) return undefined;
        candidate = requestId;
      }
      return candidate;
    };

    const identifyTurnProjection = (
      session: NativeSession,
      projection: PiFamilyProjectedEvent,
    ): PiFamilyProjectedEvent | undefined => {
      if (
        (projection.kind !== "turn.started" &&
          projection.kind !== "turn.settled" &&
          projection.kind !== "plan.updated") ||
        projection.requestId !== undefined
      ) {
        return projection;
      }
      const requestId = inferTurnRequestId(session);
      if (requestId !== undefined) return { ...projection, requestId };
      return projection.kind === "turn.settled" ? undefined : projection;
    };

    const correlateResponse = (
      session: NativeSession,
      frame: RpcResponse,
    ): { readonly id: string; readonly pending: Pending } | undefined => {
      const responseId = asString(frame.id);
      if (Object.hasOwn(frame, "id")) {
        if (responseId === undefined) return undefined;
        const pending = session.pending.get(responseId);
        return pending === undefined ? undefined : { id: responseId, pending };
      }
      let match: { readonly id: string; readonly pending: Pending } | undefined;
      for (const [id, pending] of session.pending) {
        if (pending.command !== frame.command) continue;
        if (match !== undefined) return undefined;
        match = { id, pending };
      }
      return match;
    };

    const handleFrame = (
      session: NativeSession,
      value: unknown,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.try({
        try: () => asRecord(value) ?? parseJsonObject(decodeText(value)),
        catch: (cause) => nativeError(config.provider, "decode", cause),
      }).pipe(
        Effect.flatMap((frame) => {
          const id = asString(frame.id);
          if (isRpcResponse(frame)) {
            if (Object.hasOwn(frame, "id") && id === undefined) {
              const matches = [...session.pending].filter(
                ([, pending]) => pending.command === frame.command,
              );
              if (matches.length !== 1) return Effect.void;
              const [pendingId, pending] = matches[0]!;
              session.pending.delete(pendingId);
              return Deferred.fail(
                pending.deferred,
                new ProviderAdapterRequestError({
                  provider: config.provider,
                  method: frame.command,
                  detail: "Native RPC response ID must be a string.",
                  reason: "protocol",
                }),
              ).pipe(Effect.ignore);
            }
            const correlation = correlateResponse(session, frame);
            if (correlation) {
              const correlatedId = correlation.id;
              const pending = correlation.pending.deferred;
              session.pending.delete(correlatedId);
              if (frame.success && frame.command === "prompt") {
                if (asRecord(frame.data)?.agentInvoked === false) {
                  session.acceptedPromptIds.delete(correlatedId);
                  session.activeTurns.delete(correlatedId);
                  return Deferred.succeed(pending, frame).pipe(
                    Effect.andThen(
                      offerProjection(session, {
                        kind: "turn.settled",
                        requestId: correlatedId,
                        raw: frame,
                      }),
                    ),
                  );
                }
                session.acceptedPromptIds.add(correlatedId);
              }
              return frame.success
                ? Deferred.succeed(pending, frame).pipe(Effect.ignore)
                : Deferred.fail(
                    pending,
                    nativeError(config.provider, frame.command, frame.error ?? "Native RPC failed"),
                  ).pipe(Effect.ignore);
            }
            if (
              id !== undefined &&
              !frame.success &&
              frame.command === "prompt" &&
              session.acceptedPromptIds.delete(id)
            ) {
              session.activeTurns.delete(id);
              return offerProjection(session, {
                kind: "turn.settled",
                requestId: id,
                raw: frame,
              });
            }
          }
          if (frame.type === "ready" && config.runtime === "omp") {
            const ready = validateOmpReadyFrame(frame);
            session.capabilities = capabilitiesFrom(config.runtime, undefined, ready);
            return session.ready
              ? Deferred.succeed(session.ready, undefined).pipe(Effect.ignore)
              : Effect.void;
          }
          const projections = session.projector.project(frame as RpcEnvelope);
          return Effect.forEach(
            projections,
            (projection) => {
              const identifiedProjection = identifyTurnProjection(session, projection);
              if (identifiedProjection === undefined) return Effect.void;
              if (identifiedProjection.kind === "turn.started") {
                const requestId = identifiedProjection.requestId ?? "__anonymous__";
                if (session.activeTurns.has(requestId)) {
                  return Effect.void;
                }
                session.activeTurns.add(requestId);
              } else if (identifiedProjection.kind === "turn.settled") {
                if (identifiedProjection.requestId) {
                  if (
                    !session.activeTurns.has(identifiedProjection.requestId) &&
                    !session.activeTurns.has("__anonymous__") &&
                    !session.acceptedPromptIds.has(identifiedProjection.requestId)
                  ) {
                    return Effect.void;
                  }
                  session.activeTurns.delete(identifiedProjection.requestId);
                  session.activeTurns.delete("__anonymous__");
                  session.acceptedPromptIds.delete(identifiedProjection.requestId);
                } else {
                  session.activeTurns.clear();
                  session.acceptedPromptIds.clear();
                }
              } else if (
                identifiedProjection.kind === "tool.started" ||
                identifiedProjection.kind === "tool.progress"
              ) {
                session.activeTools.add(identifiedProjection.toolCallId ?? "__anonymous__");
              } else if (identifiedProjection.kind === "tool.completed") {
                if (identifiedProjection.toolCallId)
                  session.activeTools.delete(identifiedProjection.toolCallId);
                else session.activeTools.delete("__anonymous__");
              } else if (
                identifiedProjection.kind === "task.started" ||
                identifiedProjection.kind === "task.progress"
              ) {
                session.activeTasks.add(identifiedProjection.task.id);
              } else if (identifiedProjection.kind === "task.completed") {
                session.activeTasks.delete(identifiedProjection.task.id);
              } else if (
                identifiedProjection.kind === "ui.request" &&
                identifiedProjection.request.requestId !== undefined
              ) {
                const requestKind = identifiedProjection.request.kind;
                if (
                  requestKind === "confirm" ||
                  requestKind === "select" ||
                  requestKind === "input" ||
                  requestKind === "editor"
                ) {
                  session.uiRequestKinds.set(identifiedProjection.request.requestId, requestKind);
                }
              }
              return offerProjection(session, identifiedProjection);
            },
            { discard: true },
          );
        }),
        Effect.catch((cause) =>
          offerProjection(session, {
            kind: "runtime.error",
            error: cause instanceof Error ? cause : new Error(String(cause)),
          }),
        ),
      );

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> => {
      let createdTraceSink: NativeTraceSink | undefined;
      let sessionInstalled = false;
      return Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== config.provider) {
          return yield* new ProviderAdapterValidationError({
            provider: config.provider,
            operation: "startSession",
            issue: `Expected ${config.provider}.`,
          });
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== config.instanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: config.provider,
            operation: "startSession",
            issue: `Expected provider instance ${config.instanceId}.`,
          });
        }
        const cwd = input.cwd ?? config.cwd;
        const cwdIsDirectory = yield* Effect.try({
          try: () => NodeFS.statSync(cwd).isDirectory(),
          catch: (cause) =>
            processError(
              config.provider,
              input.threadId,
              `Native working directory '${cwd}' is unavailable.`,
              cause,
            ),
        });
        if (!cwdIsDirectory) {
          return yield* processError(
            config.provider,
            input.threadId,
            `Native working directory '${cwd}' is not a directory.`,
          );
        }
        if (sessions.has(input.threadId)) yield* stopSession(input.threadId);
        const traceSinkFactory = config.traceSinkFactory;
        const traceSink =
          traceSinkFactory === undefined
            ? undefined
            : yield* Effect.try({
                try: () =>
                  traceSinkFactory.create({
                    threadId: input.threadId,
                    provider: config.provider,
                    providerInstanceId: config.instanceId,
                    runtime: config.runtime,
                  }),
                catch: () =>
                  processError(
                    config.provider,
                    input.threadId,
                    "Native trace sink factory failed while starting the session.",
                  ),
              });
        createdTraceSink = traceSink;
        const sessionScope = yield* Scope.make("sequential");
        const environment = {
          ...config.environment,
          ...(config.agentDirectory ? { PI_CODING_AGENT_DIR: config.agentDirectory } : {}),
        };
        const nativeResumeCursor = readNativeSessionResumeCursor(input.resumeCursor);
        if (nativeResumeCursor !== undefined && nativeResumeCursor.runtime !== config.runtime) {
          return yield* new ProviderAdapterValidationError({
            provider: config.provider,
            operation: "startSession",
            issue: `${nativeResumeCursor.runtime} native session cursor cannot be resumed by ${config.runtime}.`,
          });
        }
        const baseLaunchArguments = resolvePiFamilyLaunchArguments(
          config.launchArguments,
          config.trustMode,
        );
        const launchArguments =
          nativeResumeCursor === undefined
            ? baseLaunchArguments
            : [
                ...withoutSessionSelectionArguments(baseLaunchArguments),
                config.runtime === "pi" ? "--session" : "--resume",
                nativeResumeCursor.sessionId,
              ];
        const spawnCommand = yield* resolveSpawnCommand(config.binaryPath, launchArguments, {
          env: environment,
          extendEnv: true,
        });
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              env: environment,
              extendEnv: true,
              cwd,
              shell: spawnCommand.shell,
              stdin: { stream: "pipe", endOnDone: false },
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              processError(config.provider, input.threadId, String(cause), cause),
            ),
            Effect.onError(() =>
              Scope.close(sessionScope, Exit.succeed(undefined)).pipe(Effect.ignore),
            ),
          );
        const inputQueue = yield* Queue.bounded<Uint8Array>(NATIVE_INPUT_QUEUE_CAPACITY);
        const startedAt = nowIso();
        const ready =
          config.runtime === "omp" ? yield* Deferred.make<void, ProviderAdapterError>() : undefined;
        const stdoutDrained = yield* Deferred.make<void>();
        const stderrDrained = yield* Deferred.make<void>();
        const stopComplete = yield* Deferred.make<void>();
        const session: NativeSession = {
          threadId: input.threadId,
          child,
          input: inputQueue,
          scope: sessionScope,
          projector: new PiFamilyEventProjector(config.runtime),
          pending: new Map(),
          acceptedPromptIds: new Set(),
          uiRequestKinds: new Map(),
          stopComplete,
          activeTurns: new Set(),
          interruptedTurnIds: new Set(),
          activeTools: new Set(),
          activeTasks: new Set(),
          turns: [],
          startedAt,
          ...(traceSink === undefined ? {} : { traceSink }),
          stdoutDrained,
          stderrDrained,
          exitRecorded: false,
          traceInvalidated: false,
          traceFinalized: false,
          stopped: false,
          startupComplete: false,
          ...(ready ? { ready } : {}),
          session: {
            provider: config.provider,
            providerInstanceId: input.providerInstanceId ?? config.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
            ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          capabilities: absentRuntimeCapabilities(config.runtime),
          stderrBytes: new Uint8Array(),
          eventOccurrenceBuckets: new Float64Array(EVENT_OCCURRENCE_BUCKET_COUNT),
        };
        sessions.set(input.threadId, session);
        sessionInstalled = true;

        yield* Stream.fromEffectRepeat(Queue.take(inputQueue)).pipe(
          Stream.runForEach((bytes) =>
            Stream.make(bytes).pipe(
              Stream.run(child.stdin),
              Effect.andThen(recordBytes(session, "stdin", bytes)),
            ),
          ),
          Effect.catch((cause) =>
            isProviderAdapterProcessError(cause) ? failSession(session, cause) : Effect.void,
          ),
          Effect.forkIn(sessionScope),
        );

        const decoder = new StrictJsonlDecoder(config.maxLineBytes);
        const chunks = new OmpChunkAssembler(config.maxMessageBytes);
        const reportDecodeError = (cause: unknown): Effect.Effect<void> =>
          offerProjection(session, {
            kind: "runtime.error",
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        const processLine = (line: string): Effect.Effect<void> =>
          Effect.try({
            try: () => {
              const frame = parseJsonObject(line);
              return config.runtime === "omp" ? chunks.accept(frame) : frame;
            },
            catch: (cause) => nativeError(config.provider, "decode", cause),
          }).pipe(
            Effect.flatMap((frame) => (frame ? handleFrame(session, frame) : Effect.void)),
            Effect.catch(reportDecodeError),
          );
        const readStdout = Stream.runForEach(child.stdout, (chunk) =>
          recordBytes(session, "stdout", chunk).pipe(
            Effect.andThen(
              Effect.try({
                try: () => decoder.push(chunk),
                catch: (cause) => nativeError(config.provider, "decode", cause),
              }).pipe(
                Effect.catch((cause) => {
                  decoder.reset();
                  return reportDecodeError(cause).pipe(Effect.as<string[]>([]));
                }),
                Effect.flatMap((lines) => Effect.forEach(lines, processLine, { discard: true })),
              ),
            ),
          ),
        ).pipe(
          Effect.catch((cause) =>
            isProviderAdapterProcessError(cause) ? failSession(session, cause) : Effect.void,
          ),
          Effect.ensuring(Deferred.succeed(session.stdoutDrained, undefined)),
          Effect.forkIn(sessionScope),
        );
        yield* readStdout;
        const readStderr = Stream.runForEach(child.stderr, (chunk) =>
          recordBytes(session, "stderr", chunk).pipe(
            Effect.andThen(
              Effect.sync(() => {
                session.stderrBytes = appendBoundedUtf8Tail(
                  session.stderrBytes,
                  chunk,
                  config.stderrLimitBytes,
                );
              }),
            ),
          ),
        ).pipe(
          Effect.catch((cause) =>
            isProviderAdapterProcessError(cause) ? failSession(session, cause) : Effect.void,
          ),
          Effect.ensuring(Deferred.succeed(session.stderrDrained, undefined)),
          Effect.forkIn(sessionScope),
        );
        yield* readStderr;

        yield* Effect.gen(function* () {
          const observedExit = yield* Effect.exit(child.exitCode);
          if (session.traceSink !== undefined && !(yield* awaitTraceDrain(session))) {
            yield* invalidateTrace(session);
            yield* failSession(
              session,
              processError(
                config.provider,
                session.threadId,
                "Native trace output streams did not drain before the lifecycle deadline.",
              ),
            );
            return;
          }
          if (session.stopped) return;
          const code = Exit.isSuccess(observedExit) ? Number(observedExit.value) : null;
          const signal = Exit.isFailure(observedExit)
            ? exitSignalFromCause(Cause.squash(observedExit.cause))
            : null;
          if (Exit.isFailure(observedExit) && signal === null) {
            yield* failSession(
              session,
              processError(
                config.provider,
                session.threadId,
                "Native process termination signal could not be observed.",
                observedExit.cause,
              ),
            );
            return;
          }
          if (!session.startupComplete) yield* invalidateTrace(session);
          yield* recordExit(session, code, signal).pipe(
            Effect.catch((failure) => failSession(session, failure)),
          );
          if (session.stopped) return;
          yield* finalizeTrace(session).pipe(
            Effect.catch((failure) => failSession(session, failure)),
          );
          if (session.stopped) return;
          session.stopped = true;
          sessions.delete(input.threadId);
          yield* Queue.shutdown(session.input);
          yield* failPending(
            session,
            nativeError(
              config.provider,
              "process",
              code === null
                ? `Native process exited after signal ${signal}`
                : `Native process exited with code ${code}`,
            ),
          );
          yield* offerProjection(session, {
            kind: "runtime.exit",
            code,
            signal,
            stderr: new TextDecoder().decode(session.stderrBytes),
          });
          yield* Effect.forkDetach(
            Scope.close(session.scope, Exit.succeed(undefined)).pipe(Effect.ignore),
          );
        }).pipe(Effect.forkIn(sessionScope));

        if (ready) {
          yield* Deferred.await(ready).pipe(
            Effect.timeout(config.startupTimeoutMs),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                processError(
                  config.provider,
                  input.threadId,
                  "OMP did not emit a valid ready frame",
                ),
              ),
            ),
          );
          const negotiationId = randomId();
          const negotiationResponse = yield* request(
            session,
            makeOmpNegotiateProtocolCommand(negotiationId),
            "negotiate_protocol",
          );
          yield* Effect.try({
            try: () => validateOmpNegotiateProtocolResponse(negotiationResponse),
            catch: (cause) => nativeError(config.provider, "negotiate_protocol", cause),
          });
          session.capabilities = capabilitiesFrom(
            config.runtime,
            { protocolVersion: 2, negotiatedProtocolVersion: 2 },
            {
              protocolVersion: 2,
              supportedProtocolVersions: [1, 2],
              maxFrameBytes: 1_048_576,
              maxReassembledFrameBytes: 67_108_864,
            },
          );
        } else {
          session.capabilities = capabilitiesFrom(config.runtime, undefined);
        }

        const capabilitiesResponse = yield* request(
          session,
          { type: "get_capabilities" },
          "get_capabilities",
          Math.min(config.requestTimeoutMs, 1_000),
        ).pipe(
          Effect.catch((error) =>
            error.reason === "native" || error.reason === "timeout"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
        if (session.stopped) {
          return yield* processError(
            config.provider,
            input.threadId,
            "Native session stopped during startup.",
          );
        }
        if (capabilitiesResponse) {
          if (
            capabilitiesResponse.data !== undefined &&
            asRecord(capabilitiesResponse.data) === undefined
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: config.provider,
              method: "get_capabilities",
              detail: "Native capability discovery returned malformed response data.",
            });
          }
          const maxFrameBytes = session.capabilities.transport.maxFrameBytes;
          const maxReassembledFrameBytes = session.capabilities.transport.maxReassembledFrameBytes;
          session.capabilities = capabilitiesFrom(config.runtime, capabilitiesResponse.data, {
            protocolVersion: session.capabilities.protocolVersion,
            supportedProtocolVersions: session.capabilities.supportedProtocolVersions,
            ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
            ...(maxReassembledFrameBytes === undefined ? {} : { maxReassembledFrameBytes }),
          });
        }
        if (config.runtime === "omp" && session.capabilities.tasks.lifecycle) {
          yield* request(
            session,
            { type: "set_subagent_subscription", level: "events" },
            "set_subagent_subscription",
          );
        }

        if (nativeResumeCursor !== undefined) {
          session.nativeSessionId = nativeResumeCursor.sessionId;
        } else if (input.resumeCursor !== undefined) {
          if (session.capabilities.sessions.nativeCheckpoint) {
            const descriptor = readCheckpointDescriptor(input.resumeCursor);
            if (!descriptor || descriptor.runtime !== config.runtime) {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "startSession",
                issue: `Native ${config.runtime} resume cursor is not a matching checkpoint descriptor.`,
              });
            }
            session.nativeSessionId = descriptor.sessionId!;
            if (config.runtime === "omp") {
              yield* request(
                session,
                {
                  type: "rewind",
                  report: "T3 Code restored the native snapshot.",
                  mode: "snapshot",
                  checkpointId: descriptor.leafEntryId,
                },
                "rewind",
              );
            } else {
              yield* request(
                session,
                { type: "restore_checkpoint", checkpoint: descriptor.opaque },
                "restore_checkpoint",
              );
            }
          } else if (!session.capabilities.sessions.resume) {
            return yield* new ProviderAdapterRequestError({
              provider: config.provider,
              method: "restore_checkpoint",
              detail: `Native ${config.runtime} does not advertise checkpoint or resume support.`,
            });
          }
        }
        if (config.runtime === "omp" || nativeResumeCursor !== undefined) {
          const stateResponse = yield* request(session, { type: "get_state" }, "get_state");
          const state = asRecord(stateResponse.data);
          const nativeSessionId = asString(state?.sessionId);
          if (nativeSessionId === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: config.provider,
              method: "get_state",
              detail: `${config.runtime.toUpperCase()} returned state without a session id.`,
              reason: "protocol",
            });
          }
          if (
            nativeResumeCursor !== undefined &&
            nativeSessionId !== nativeResumeCursor.sessionId
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: config.provider,
              method: "get_state",
              detail: `${config.runtime.toUpperCase()} resumed '${nativeSessionId}' instead of '${nativeResumeCursor.sessionId}'.`,
              reason: "protocol",
            });
          }
          const modelId = nativeModelSlug(state?.model);
          bindNativeSessionIdentity(session, config.runtime, nativeSessionId, modelId, false);
        }
        session.startupComplete = true;
        yield* offer({
          ...makeBase(
            config,
            input.threadId,
            { type: "session.started", id: input.threadId },
            undefined,
            0,
          ),
          type: "session.started",
          payload: { message: `Started native ${config.runtime} session` },
        });
        return session.session;
      }).pipe(
        Effect.onError(() => {
          const session = sessions.get(input.threadId);
          const invalidate =
            session !== undefined
              ? invalidateTrace(session)
              : sessionInstalled || createdTraceSink === undefined
                ? Effect.void
                : Effect.sync(() => createdTraceSink?.invalidate()).pipe(Effect.ignore);
          return invalidate.pipe(Effect.andThen(stopSession(input.threadId)));
        }),
      );
    };
    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId);
        const turnId = TurnId.make(randomId());
        const imageResult = yield* nativePromptImages(input, config.attachmentsDir);
        if (imageResult.unavailable.length > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: "prompt",
            detail: `Native ${config.runtime} cannot send image attachment bytes: ${imageResult.unavailable.join(", ")}.`,
          });
        }
        if (input.modelSelection && input.modelSelection.instanceId === config.instanceId) {
          const slash = input.modelSelection.model.indexOf("/");
          if (!session.capabilities.models.switch) {
            if (session.session.model !== input.modelSelection.model) {
              return yield* new ProviderAdapterRequestError({
                provider: config.provider,
                method: "set_model",
                detail: `Native ${config.runtime} cannot switch models after session startup.`,
              });
            }
          } else {
            if (slash <= 0 || slash >= input.modelSelection.model.length - 1) {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "sendTurn",
                issue: "Native model selection must use provider/model format.",
              });
            }
            yield* request(
              session,
              {
                type: "set_model",
                provider: input.modelSelection.model.slice(0, slash),
                modelId: input.modelSelection.model.slice(slash + 1),
              },
              "set_model",
            );
          }
          const seenOptions = new Set<string>();
          let thinkingLevel: string | undefined;
          for (const option of input.modelSelection.options ?? []) {
            if (seenOptions.has(option.id)) {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "sendTurn",
                issue: "Native model selection contains a duplicate option.",
              });
            }
            seenOptions.add(option.id);
            if (option.id !== "thinkingLevel") {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "sendTurn",
                issue: "Native model selection contains an unsupported option.",
              });
            }
            if (typeof option.value !== "string") {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "sendTurn",
                issue: 'Native "thinkingLevel" must be a supported level for the selected model.',
              });
            }
            thinkingLevel = option.value;
          }
          if (thinkingLevel !== undefined) {
            if (!session.capabilities.thinking.switch) {
              return yield* new ProviderAdapterRequestError({
                provider: config.provider,
                method: "set_thinking_level",
                detail: `Native ${config.runtime} does not advertise thinking-level switching.`,
              });
            }
            const stateResponse = yield* request(session, { type: "get_state" }, "get_state");
            const stateData = asRecord(stateResponse.data);
            const availableLevels = piFamilyThinkingLevels(config.runtime, stateData?.model);
            if (!availableLevels.some((level) => level === thinkingLevel)) {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "sendTurn",
                issue:
                  'Native "thinkingLevel" is unavailable for the selected model. Refresh provider models and choose an advertised level.',
              });
            }
            yield* request(
              session,
              { type: "set_thinking_level", level: thinkingLevel },
              "set_thinking_level",
            );
          }
        }
        yield* request(
          session,
          {
            type: "prompt",
            id: turnId,
            message: input.input ?? "",
            ...(imageResult.images.length === 0 ? {} : { images: imageResult.images }),
          },
          "prompt",
        );
        session.turns.push({ id: turnId, items: [] });
        return { threadId: input.threadId, turnId };
      });

    const interruptTurn = (
      threadId: ThreadId,
      turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.gen(function* () {
            const requestedTurnIds =
              turnId === undefined
                ? [...session.activeTurns, ...session.acceptedPromptIds]
                : [String(turnId)];
            yield* Effect.sync(() => {
              for (const requestedTurnId of requestedTurnIds) {
                if (requestedTurnId !== "__anonymous__") {
                  session.interruptedTurnIds.add(requestedTurnId);
                }
              }
            });

            yield* request(
              session,
              {
                type: "abort",
                ...(turnId ? { turnId } : {}),
              },
              "abort",
            ).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  for (const requestedTurnId of requestedTurnIds) {
                    session.interruptedTurnIds.delete(requestedTurnId);
                  }
                }),
              ),
            );
          }),
        ),
      );
    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.gen(function* () {
            const accepted = decision === "accept" || decision === "acceptForSession";
            const requestKind = session.uiRequestKinds.get(requestId);
            if (requestKind === "confirm" || requestKind === undefined) {
              yield* send(session, {
                type: "extension_ui_response",
                id: requestId,
                ...(decision === "cancel" ? { cancelled: true } : { confirmed: accepted }),
              });
            } else if (decision === "cancel") {
              yield* send(session, {
                type: "extension_ui_response",
                id: requestId,
                cancelled: true,
              });
            } else {
              return yield* new ProviderAdapterValidationError({
                provider: config.provider,
                operation: "respondToRequest",
                issue: `Native ${requestKind} requests require respondToUserInput.`,
              });
            }
            session.uiRequestKinds.delete(requestId);
          }),
        ),
      );
    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterError> =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.gen(function* () {
            yield* send(session, {
              type: "extension_ui_response",
              id: requestId,
              value: nativeInputValue(answers),
            });
            session.uiRequestKinds.delete(requestId);
          }),
        ),
      );

    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      requireSession(threadId).pipe(
        Effect.map((session) => ({
          threadId,
          turns: session.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        })),
      );
    const listNativeSessions = (
      input: ProviderNativeSessionListInput,
    ): Effect.Effect<ReadonlyArray<ProviderNativeSessionSummary>, ProviderNativeSessionError> => {
      if (input.providerInstanceId !== config.instanceId) {
        return Effect.fail(
          new ProviderNativeSessionError({
            code: "invalid",
            message: `Expected provider instance ${config.instanceId}.`,
          }),
        );
      }
      return listPiFamilyNativeSessions(config, config.instanceId, input.cwd);
    };

    const pageNativeHistory = (
      messages: ReadonlyArray<ProviderNativeHistoryMessage>,
      cursor?: string,
      pageSize = 64,
    ): Effect.Effect<ProviderNativeHistoryPage, ProviderNativeSessionError> => {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return Effect.fail(
          new ProviderNativeSessionError({
            code: "invalid",
            message: "Native history cursor is invalid.",
          }),
        );
      }
      const pageMessages = messages.slice(offset, offset + pageSize);
      const nextOffset = offset + pageMessages.length;
      return Effect.succeed({
        messages: pageMessages,
        ...(nextOffset < messages.length ? { nextCursor: String(nextOffset) } : {}),
        totalMessages: messages.length,
      });
    };
    const readNativeHistoryBySession = (input: {
      readonly sessionId: string;
      readonly cwd: string;
      readonly cursor?: string;
    }): Effect.Effect<ProviderNativeHistoryPage, ProviderNativeSessionError> =>
      readPiFamilyNativeHistoryMessages(config, input.sessionId, input.cwd, {
        maxBytes: OFFLINE_NATIVE_HISTORY_MAX_BYTES,
      }).pipe(Effect.flatMap((messages) => pageNativeHistory(messages, input.cursor, 256)));
    const readNativeHistory = (
      threadId: ThreadId,
      cursor?: string,
    ): Effect.Effect<
      ProviderNativeHistoryPage,
      ProviderAdapterError | ProviderNativeSessionError
    > =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        const sessionId = session.nativeSessionId;
        if (sessionId === undefined) {
          return yield* new ProviderNativeSessionError({
            code: "invalid",
            message: `${config.runtime.toUpperCase()} did not report a native session id.`,
          });
        }
        const messages =
          session.nativeHistoryMessages ??
          (yield* readPiFamilyNativeHistoryMessages(
            config,
            sessionId,
            session.session.cwd ?? config.cwd,
          ));
        session.nativeHistoryMessages = messages;
        return yield* pageNativeHistory(messages, cursor);
      });
    const readSubagentTranscript = (
      threadId: ThreadId,
      subagentId: string,
      cursor?: string,
    ): Effect.Effect<
      ProviderSubagentTranscriptReadResult,
      ProviderAdapterError | ProviderNativeSessionError
    > =>
      Effect.gen(function* () {
        if (config.runtime !== "omp") {
          return yield* new ProviderNativeSessionError({
            code: "unsupported",
            message: "Subagent transcripts are only available for OMP sessions.",
          });
        }
        const fromByte = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(fromByte) || fromByte < 0) {
          return yield* new ProviderNativeSessionError({
            code: "invalid",
            message: "Subagent transcript cursor is invalid.",
          });
        }
        const session = yield* requireSession(threadId);
        const response = yield* request(
          session,
          { type: "get_subagent_messages", subagentId, fromByte },
          "get_subagent_messages",
        );
        const transcript = transcriptEntriesFromResponse(response);
        if (transcript === undefined) {
          return yield* new ProviderNativeSessionError({
            code: "native",
            message: "OMP returned an invalid subagent transcript response.",
          });
        }
        return transcript;
      });
    const renameNativeSession = (
      threadId: ThreadId,
      name: string,
    ): Effect.Effect<void, ProviderAdapterError | ProviderNativeSessionError> =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        if (!isQuiescent(session)) {
          return yield* new ProviderNativeSessionError({
            code: "invalid",
            message: "Native session cannot be renamed while work is active.",
          });
        }
        yield* request(session, { type: "set_session_name", name }, "set_session_name");
        session.session = {
          ...session.session,
          updatedAt: nowIso(),
        };
      });

    const forkNativeSession = (
      threadId: ThreadId,
    ): Effect.Effect<
      { readonly sessionId: string },
      ProviderAdapterError | ProviderNativeSessionError
    > =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        if (!isQuiescent(session)) {
          return yield* new ProviderNativeSessionError({
            code: "invalid",
            message: "Native session cannot be forked while work is active.",
          });
        }
        if (!session.capabilities.sessions.fork) {
          return yield* new ProviderNativeSessionError({
            code: "unsupported",
            message: `Native ${config.runtime} does not support session forks.`,
          });
        }
        const oldSessionId = session.nativeSessionId;
        if (config.runtime === "pi") {
          const response = yield* request(session, { type: "clone" }, "clone");
          if (asRecord(response.data)?.cancelled === true) {
            return yield* new ProviderNativeSessionError({
              code: "native",
              message: "Pi cancelled the session fork.",
            });
          }
        } else {
          const candidatesResponse = yield* request(
            session,
            { type: "get_branch_messages" },
            "get_branch_messages",
          );
          const messages = asRecord(candidatesResponse.data)?.messages;
          const latest =
            Array.isArray(messages) && messages.length > 0
              ? asRecord(messages[messages.length - 1])
              : undefined;
          const entryId = asString(latest?.entryId);
          if (entryId === undefined) {
            return yield* new ProviderNativeSessionError({
              code: "invalid",
              message: "OMP cannot fork a session without a branchable user message.",
            });
          }
          const response = yield* request(session, { type: "branch", entryId }, "branch");
          if (asRecord(response.data)?.cancelled === true) {
            return yield* new ProviderNativeSessionError({
              code: "native",
              message: "OMP cancelled the session fork.",
            });
          }
        }
        const stateResponse = yield* request(session, { type: "get_state" }, "get_state");
        const sessionId = asString(asRecord(stateResponse.data)?.sessionId);
        if (sessionId === undefined || sessionId === oldSessionId) {
          return yield* new ProviderNativeSessionError({
            code: "native",
            message: `Native ${config.runtime} did not create a distinct forked session.`,
          });
        }
        bindNativeSessionIdentity(session, config.runtime, sessionId, undefined, true);
        return { sessionId };
      });

    const rollbackThread = (
      threadId: ThreadId,
      numTurns: number,
    ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        if (!Number.isSafeInteger(numTurns) || numTurns < 0) {
          return yield* new ProviderAdapterValidationError({
            provider: config.provider,
            operation: "rollbackThread",
            issue: "numTurns must be a non-negative safe integer.",
          });
        }
        if (numTurns === 0) {
          return {
            threadId,
            turns: session.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
          };
        }
        if (!isQuiescent(session)) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: "rollback",
            detail: "Native runtime is not quiescent.",
          });
        }
        if (!session.capabilities.sessions.completeTurnRollback) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: "rollback",
            detail: `Native ${config.runtime} does not advertise complete-turn rollback.`,
          });
        }
        yield* request(session, { type: "rollback_turns", turns: numTurns }, "rollback");
        session.turns.splice(Math.max(0, session.turns.length - numTurns), numTurns);
        return {
          threadId,
          turns: session.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      });
    const captureNativeCheckpoint = (
      threadId: ThreadId,
    ): Effect.Effect<unknown | undefined, ProviderAdapterError> =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        if (!isQuiescent(session)) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: config.runtime === "omp" ? "checkpoint" : "capture_checkpoint",
            detail: "Native runtime is not quiescent.",
          });
        }
        if (!session.capabilities.sessions.nativeCheckpoint) {
          return undefined;
        }
        const response = yield* request(
          session,
          config.runtime === "omp"
            ? { type: "checkpoint", goal: "T3 Code filesystem checkpoint", mode: "snapshot" }
            : { type: "capture_checkpoint" },
          config.runtime === "omp" ? "checkpoint" : "capture_checkpoint",
        );
        const descriptor = checkpointDescriptor(
          config.runtime,
          session.capabilities.runtimeVersion,
          response.data,
        );
        if (!descriptor) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: config.runtime === "omp" ? "checkpoint" : "capture_checkpoint",
            detail: "Native runtime returned an invalid checkpoint descriptor.",
          });
        }
        session.nativeSessionId = descriptor.sessionId!;
        return descriptor;
      });
    const restoreNativeCheckpoint = (
      threadId: ThreadId,
      checkpoint: unknown,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        if (!isQuiescent(session)) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: config.runtime === "omp" ? "rewind" : "restore_checkpoint",
            detail: "Native runtime is not quiescent.",
          });
        }
        if (!session.capabilities.sessions.nativeCheckpoint) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: config.runtime === "omp" ? "rewind" : "restore_checkpoint",
            detail: `Native ${config.runtime} does not advertise native checkpoint support.`,
          });
        }
        const descriptor = readCheckpointDescriptor(checkpoint);
        if (!descriptor || descriptor.runtime !== config.runtime) {
          return yield* new ProviderAdapterValidationError({
            provider: config.provider,
            operation: "restoreNativeCheckpoint",
            issue: `Native ${config.runtime} checkpoint descriptor is stale or mismatched.`,
          });
        }
        if (
          session.nativeSessionId !== undefined &&
          session.nativeSessionId !== descriptor.sessionId
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: config.runtime === "omp" ? "rewind" : "restore_checkpoint",
            detail: "Native checkpoint belongs to a different session.",
          });
        }
        session.nativeSessionId = descriptor.sessionId!;
        if (config.runtime === "omp") {
          yield* request(
            session,
            {
              type: "rewind",
              report: "T3 Code restored the filesystem checkpoint.",
              mode: "snapshot",
              checkpointId: descriptor.leafEntryId,
            },
            "rewind",
          );
          return;
        }
        yield* request(
          session,
          { type: "restore_checkpoint", checkpoint: descriptor.opaque },
          "restore_checkpoint",
        );
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: config.provider,
      capabilities: adapterCapabilities,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.succeed(
          [...sessions.values()]
            .filter((session) => !session.stopped)
            .map((session) => session.session),
        ),
      hasSession: (threadId) =>
        Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped)),
      readThread,
      listNativeSessions,
      readNativeHistory,
      readNativeHistoryBySession,
      readSubagentTranscript,
      renameNativeSession,
      forkNativeSession,
      rollbackThread,
      captureNativeCheckpoint,
      restoreNativeCheckpoint,
      stopAll,
      streamEvents: Stream.fromEffectRepeat(Queue.take(events)),
    };

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Queue.shutdown(events)),
      ),
    );
    return adapter;
  }).pipe(Effect.orDie);
