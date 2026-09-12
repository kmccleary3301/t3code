import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { nativeEventId, nextNativeId } from "./NativeEventIdentity.ts";
import { nativeTaskLifecyclePayload } from "./NativeTaskProjection.ts";
import { nativeToolItemPayload } from "./NativeToolProjection.ts";
import {
  asRecord,
  asString,
  type JsonRecord,
  type PiFamilyProjectedEvent,
  type PiFamilyRuntimeKind,
  type RpcEnvelope,
} from "./protocol.ts";

interface NativeRuntimeEventConfig {
  readonly provider: ProviderDriverKind;
  readonly runtime: PiFamilyRuntimeKind;
  readonly instanceId: ProviderInstanceId;
}

/** Per-session canonical events, bounded identities, and active tool input context. */
export class NativeRuntimeEvents {
  private readonly toolSnapshots = new Map<string, RpcEnvelope>();
  private readonly eventOccurrenceBuckets = new Float64Array(EVENT_OCCURRENCE_BUCKET_COUNT);
  private readonly config: NativeRuntimeEventConfig;
  private readonly threadId: ThreadId;

  constructor(config: NativeRuntimeEventConfig, threadId: ThreadId) {
    this.config = config;
    this.threadId = threadId;
  }

  base(event?: RpcEnvelope, persistRaw = true): ProviderRuntimeEventBase {
    return makeBase(this.config, this.threadId, event, undefined, 0, persistRaw);
  }

  clearTools(): void {
    this.toolSnapshots.clear();
  }

  project(
    projection: PiFamilyProjectedEvent,
    interruptedTurnIds: ReadonlySet<string>,
    turnId: string | undefined,
  ): ProviderRuntimeEvent | undefined {
    const identityEvent = projectionIdentityEvent(projection);
    const nativeIdentity =
      identityEvent === undefined
        ? projection.kind
        : nativeEventId(this.config.runtime, identityEvent);
    const identityKey = `${nativeIdentity}:${projection.kind}`;
    const eventOccurrence = nextEventOccurrence(this.eventOccurrenceBuckets, identityKey);
    let canonicalProjection = projection;
    if (
      (projection.kind === "tool.started" ||
        projection.kind === "tool.progress" ||
        projection.kind === "tool.completed") &&
      projection.toolCallId !== undefined
    ) {
      const previous = this.toolSnapshots.get(projection.toolCallId);
      const mergedRaw =
        previous === undefined ? projection.raw : { ...previous, ...projection.raw };
      canonicalProjection = { ...projection, raw: mergedRaw };
      if (projection.kind === "tool.completed") {
        this.toolSnapshots.delete(projection.toolCallId);
      } else {
        // Results belong to the emitted event, not the active-call input cache.
        const callContext: RpcEnvelope = { ...mergedRaw };
        delete callContext.result;
        delete callContext.partialResult;
        delete callContext.output;
        this.toolSnapshots.set(projection.toolCallId, callContext);
      }
    }
    return eventForProjection(
      this.config,
      this.threadId,
      canonicalProjection,
      interruptedTurnIds,
      eventOccurrence,
      turnId,
    );
  }
}
const EVENT_OCCURRENCE_BUCKET_COUNT = 4_096;

function nextEventOccurrence(buckets: Float64Array, identity: string): number {
  let hash = 2_166_261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  const bucket = (hash >>> 0) % buckets.length;
  const occurrence = buckets[bucket]!;
  buckets[bucket] = occurrence + 1;
  return occurrence;
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
function assistantMessageItemId(raw: RpcEnvelope, threadId: ThreadId): string | undefined {
  const message = asRecord(raw.message) ?? asRecord(raw.assistantMessage) ?? asRecord(raw.data);
  return (
    asString(message?.id) ??
    asString(message?.messageId) ??
    asString(raw.messageId) ??
    asString(raw.id) ??
    (typeof message?.timestamp === "number"
      ? `${threadId}:native-message:${message.timestamp}`
      : undefined)
  );
}

function assistantMessageFields(
  raw: RpcEnvelope,
  threadId: ThreadId,
): {
  readonly itemId?: string;
  readonly detail?: string;
} {
  const message = asRecord(raw.message) ?? asRecord(raw.assistantMessage) ?? asRecord(raw.data);
  const messageId = assistantMessageItemId(raw, threadId);
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

function makeBase(
  config: NativeRuntimeEventConfig,
  threadId: ThreadId,
  event: RpcEnvelope | undefined,
  discriminator: string | undefined,
  eventOccurrence: number,
  persistRaw = true,
  turnId?: string,
): ProviderRuntimeEventBase {
  const eventId =
    event === undefined
      ? nextNativeId()
      : `${config.instanceId}:${threadId}:${nativeEventId(config.runtime, event, eventOccurrence)}${discriminator ? `:${discriminator}` : ""}`;
  return {
    eventId: EventId.make(eventId),
    provider: config.provider,
    providerInstanceId: config.instanceId,
    threadId,
    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    ...(turnId === undefined ? {} : { turnId: TurnId.make(turnId) }),
    ...(event === undefined || !persistRaw
      ? {}
      : {
          raw: {
            source: config.runtime === "pi" ? "pi.rpc" : "omp.rpc",
            payload: persistedNativeEnvelope(event),
          },
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
  config: NativeRuntimeEventConfig,
  threadId: ThreadId,
  projected: PiFamilyProjectedEvent,
  interruptedTurnIds: ReadonlySet<string>,
  eventOccurrence: number,
  turnId: string | undefined,
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
  const base = makeBase(config, threadId, raw, discriminator, eventOccurrence, true, turnId);
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
    case "message.delta": {
      const itemId = assistantMessageItemId(projected.raw, threadId);
      return {
        ...base,
        type: "content.delta",
        ...(itemId === undefined ? {} : { itemId: RuntimeItemId.make(itemId) }),
        payload: {
          streamKind: projected.channel === "reasoning" ? "reasoning_text" : "assistant_text",
          delta: projected.text,
        },
      };
    }
    case "tool.started":
    case "tool.progress":
    case "tool.completed": {
      const toolId = projected.toolCallId;
      return {
        ...base,
        type:
          projected.kind === "tool.started"
            ? "item.started"
            : projected.kind === "tool.progress"
              ? "item.updated"
              : "item.completed",
        ...(toolId === undefined ? {} : { itemId: RuntimeItemId.make(toolId) }),
        payload: nativeToolItemPayload(
          projected.raw,
          projected.kind === "tool.started"
            ? "started"
            : projected.kind === "tool.progress"
              ? "updated"
              : "completed",
        ),
      };
    }
    case "message.completed": {
      const message = assistantMessageFields(projected.raw, threadId);
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
      const payload = nativeTaskLifecyclePayload(projected.task);
      if (projected.kind !== "task.completed") {
        return { ...base, type: projected.kind, payload };
      }
      return {
        ...base,
        type: "task.completed",
        payload: {
          ...payload,
          status:
            projected.task.status === "failed"
              ? "failed"
              : projected.task.status === "cancelled" || projected.task.status === "interrupted"
                ? "stopped"
                : "completed",
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
      const requestId = RuntimeRequestId.make(request.requestId ?? nextNativeId());
      if (request.kind === "askDialog") {
        return {
          ...base,
          type: "user-input.requested",
          requestId,
          payload: {
            questions: request.questions.map((q, idx) => ({
              id: q.id && q.id.length > 0 ? q.id : `q-${idx}`,
              header: q.header ?? "Question",
              question: q.question,
              options: q.options.map((option) => ({
                label: option.label,
                description: option.description ?? option.label,
              })),
              multiSelect: q.multi ?? false,
            })),
          },
        };
      }
      if (request.kind === "cancel") {
        return undefined;
      }
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
