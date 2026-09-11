// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import {
  ApprovalRequestId,
  ProviderNativeSessionError,
  ProviderNativeCommandError,
  ProviderDriverKind,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderNativeSessionListInput,
  ProviderNativeSessionResumeCursor,
  type ProviderNativeSessionSummary,
  type ProviderSendTurnInput,
  type ProviderSubagentTranscriptReadResult,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ServerProviderSlashCommand,
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
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";
import { PiFamilyEventProjector } from "./PiFamilyEventProjector.ts";
import { nextNativeId } from "./NativeEventIdentity.ts";
import { NativeRuntimeEvents } from "./NativeRuntimeEvents.ts";
import { transcriptEntriesFromResponse } from "./NativeSubagentTranscript.ts";
import {
  absentRuntimeCapabilities,
  asRecord,
  asString,
  isRpcResponse,
  makeOmpNegotiateProtocolCommand,
  readRuntimeCapabilities,
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
import {
  discoverPiFamilyCommands,
  mapPiFamilySlashCommands,
  piFamilyThinkingLevels,
  resolvePiFamilyLaunchArguments,
} from "./ModelDiscovery.ts";
import {
  listPiFamilyNativeSessions,
  readPiFamilyNativeHistoryMessages,
  readPiFamilyNativeSubagentTranscript,
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
type IdentifiedNativeProjection =
  | Exclude<PiFamilyProjectedEvent, { readonly kind: "turn.started" | "turn.settled" }>
  | (Extract<PiFamilyProjectedEvent, { readonly kind: "turn.started" | "turn.settled" }> & {
      readonly requestId: string;
    });

interface NativeSession {
  readonly threadId: ThreadId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly input: Queue.Queue<Uint8Array, never>;
  readonly scope: Scope.Closeable;
  readonly projector: PiFamilyEventProjector;
  readonly pending: Map<string, Pending>;
  readonly acceptedPromptIds: Set<string>;
  readonly uiRequestKinds: Map<string, "confirm" | "select" | "input" | "editor" | "askDialog">;
  readonly activeTurns: Set<string>;
  readonly interruptedTurnIds: Set<string>;
  readonly activeTools: Set<string>;
  readonly activeTasks: Map<string, string | undefined>;
  readonly runtimeEvents: NativeRuntimeEvents;
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
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  capabilities: RuntimeCapabilities;
  stderrBytes: Uint8Array;
}

interface Pending {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, ProviderAdapterRequestError>;
}

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

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

export const makePiFamilyAdapter = (
  config: PiFamilyNativeConfig,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const discoverNativeCommands: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["discoverNativeCommands"]
    > = (input) =>
      discoverPiFamilyCommands({ ...config, cwd: input.workspaceRoot }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(
          (cause) =>
            new ProviderNativeCommandError({
              code: "discovery",
              message: cause.message,
            }),
        ),
      );
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
    const offerCommandCatalog = (
      session: NativeSession,
      slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
    ): Effect.Effect<void> =>
      offer({
        ...session.runtimeEvents.base(undefined, false),
        type: "session.configured",
        payload: { config: { slashCommands } },
      });
    const updateCommandCatalog = (session: NativeSession, rows: unknown) =>
      Effect.try({
        try: () => mapPiFamilySlashCommands(rows),
        catch: (cause) => nativeError(config.provider, "get_commands", cause),
      }).pipe(
        Effect.flatMap((commands) => {
          session.slashCommands = commands;
          return session.startupComplete ? offerCommandCatalog(session, commands) : Effect.void;
        }),
      );
    const offerProjection = (
      session: NativeSession,
      projection: PiFamilyProjectedEvent,
      turnId?: string,
    ): Effect.Effect<void> => {
      if (projection.kind === "ui.request" && projection.request.kind === "cancel") {
        const targetId = projection.request.targetId;
        const targetKind = session.uiRequestKinds.get(targetId);
        session.uiRequestKinds.delete(targetId);
        if (targetKind === "confirm" || targetKind === "input" || targetKind === "editor") {
          return offer({
            ...session.runtimeEvents.base(undefined, false),
            type: "request.resolved",
            requestId: RuntimeRequestId.make(targetId),
            payload: {
              requestType:
                targetKind === "confirm" ? "command_execution_approval" : "tool_user_input",
              decision: "cancel",
            },
          });
        }
        return offer({
          ...session.runtimeEvents.base(undefined, false),
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(targetId),
          payload: { answers: {} },
        });
      }
      const event = session.runtimeEvents.project(
        projection,
        session.interruptedTurnIds,
        turnId ?? inferTurnRequestId(session),
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
        for (const [requestId, kind] of session.uiRequestKinds) {
          yield* Effect.ignore(
            send(session, {
              type: "extension_ui_response",
              id: requestId,
              cancelled: true,
            }),
          );
          if (kind === "select" || kind === "askDialog") {
            yield* offer({
              ...session.runtimeEvents.base(undefined, false),
              type: "user-input.resolved",
              requestId: RuntimeRequestId.make(requestId),
              payload: { answers: {} },
            });
          } else {
            yield* offer({
              ...session.runtimeEvents.base(undefined, false),
              type: "request.resolved",
              requestId: RuntimeRequestId.make(requestId),
              payload: {
                requestType: kind === "confirm" ? "command_execution_approval" : "tool_user_input",
                decision: "cancel",
              },
            });
          }
        }
        session.uiRequestKinds.clear();
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
        session.runtimeEvents.clearTools();
        session.activeTools.clear();
        session.activeTasks.clear();
        session.activeTurns.clear();
        delete session.nativeHistoryMessages;
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
      const id = asString(envelope.id) ?? nextNativeId();
      const requestEnvelope: RpcEnvelope = { ...envelope, id, type: String(envelope.type) };
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
        if (candidate !== undefined && candidate !== requestId) return undefined;
        candidate = requestId;
      }
      if (candidate !== undefined) return candidate;
      for (const requestId of session.acceptedPromptIds) {
        if (candidate !== undefined && candidate !== requestId) return undefined;
        candidate = requestId;
      }
      if (candidate !== undefined) return candidate;
      for (const [requestId, pending] of session.pending) {
        if (pending.command !== "prompt") continue;
        if (candidate !== undefined && candidate !== requestId) return undefined;
        candidate = requestId;
      }
      return candidate;
    };

    const identifyTurnProjection = (
      session: NativeSession,
      projection: PiFamilyProjectedEvent,
    ): IdentifiedNativeProjection | undefined => {
      if (projection.kind === "turn.started" || projection.kind === "turn.settled") {
        const requestId =
          projection.requestId ??
          inferTurnRequestId(session) ??
          (projection.kind === "turn.started" ? nextNativeId() : undefined);
        return requestId === undefined ? undefined : { ...projection, requestId };
      }
      if (projection.kind === "plan.updated" && projection.requestId === undefined) {
        const requestId = inferTurnRequestId(session);
        if (requestId !== undefined) return { ...projection, requestId };
      }
      return projection;
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
      frame: RpcEnvelope,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.succeed(frame).pipe(
        Effect.flatMap((frame) => {
          if (config.runtime === "omp" && frame.type === "available_commands_update") {
            return updateCommandCatalog(session, frame.commands);
          }
          if (config.runtime === "omp" && frame.type === "command_output") {
            if (typeof frame.text !== "string") {
              return Effect.fail(
                nativeError(
                  config.provider,
                  "command_output",
                  "Native command output must be text.",
                ),
              );
            }
            return offerProjection(session, {
              kind: "message.delta",
              channel: "assistant",
              text: frame.text,
              raw: frame,
            });
          }
          if (
            config.runtime === "omp" &&
            (frame.type === "config_update" || frame.type === "session_info_update")
          ) {
            const model = nativeModelSlug(frame.model);
            const title = asString(frame.title);
            const thinkingLevel = asString(frame.thinkingLevel);
            if (model !== undefined) {
              session.session = { ...session.session, model, updatedAt: nowIso() };
            }
            return offer({
              ...session.runtimeEvents.base(undefined, false),
              type: "session.configured",
              payload: {
                config: {
                  ...(model === undefined ? {} : { model }),
                  ...(title === undefined ? {} : { title }),
                  ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
                },
              },
            });
          }
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
            session.capabilities = readRuntimeCapabilities(config.runtime, undefined, ready);
            return session.ready
              ? Deferred.succeed(session.ready, undefined).pipe(Effect.ignore)
              : Effect.void;
          }
          const projections = session.projector.project(frame);
          return Effect.forEach(
            projections,
            (projection) => {
              const identifiedProjection = identifyTurnProjection(session, projection);
              if (identifiedProjection === undefined) return Effect.void;
              const taskTurnId =
                identifiedProjection.kind === "task.started" ||
                identifiedProjection.kind === "task.progress" ||
                identifiedProjection.kind === "task.completed"
                  ? (session.activeTasks.get(identifiedProjection.task.id) ??
                    inferTurnRequestId(session))
                  : undefined;
              if (identifiedProjection.kind === "turn.started") {
                const requestId = identifiedProjection.requestId;
                if (session.activeTurns.has(requestId)) {
                  return Effect.void;
                }
                session.activeTurns.add(requestId);
              } else if (identifiedProjection.kind === "turn.settled") {
                if (
                  !session.activeTurns.has(identifiedProjection.requestId) &&
                  !session.acceptedPromptIds.has(identifiedProjection.requestId)
                ) {
                  return Effect.void;
                }
                session.activeTurns.delete(identifiedProjection.requestId);
                session.acceptedPromptIds.delete(identifiedProjection.requestId);
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
                session.activeTasks.set(identifiedProjection.task.id, taskTurnId);
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
                  requestKind === "editor" ||
                  requestKind === "askDialog"
                ) {
                  session.uiRequestKinds.set(identifiedProjection.request.requestId, requestKind);
                }
              }
              if (
                (identifiedProjection.kind === "turn.settled" ||
                  identifiedProjection.kind === "task.completed") &&
                session.activeTurns.size === 0 &&
                session.activeTasks.size === 0
              ) {
                session.runtimeEvents.clearTools();
                session.activeTools.clear();
                delete session.nativeHistoryMessages;
              }
              return offerProjection(session, identifiedProjection, taskTurnId);
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
          activeTasks: new Map(),
          runtimeEvents: new NativeRuntimeEvents(config, input.threadId),
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
          const negotiationId = nextNativeId();
          const negotiationResponse = yield* request(
            session,
            makeOmpNegotiateProtocolCommand(negotiationId, {
              ui: {
                askDialog: true,
              },
            }),
            "negotiate_protocol",
          );
          yield* Effect.try({
            try: () => validateOmpNegotiateProtocolResponse(negotiationResponse),
            catch: (cause) => nativeError(config.provider, "negotiate_protocol", cause),
          });
          session.capabilities = readRuntimeCapabilities(
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
          session.capabilities = readRuntimeCapabilities(config.runtime, undefined);
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
          session.capabilities = readRuntimeCapabilities(
            config.runtime,
            capabilitiesResponse.data,
            {
              protocolVersion: session.capabilities.protocolVersion,
              supportedProtocolVersions: session.capabilities.supportedProtocolVersions,
              ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
              ...(maxReassembledFrameBytes === undefined ? {} : { maxReassembledFrameBytes }),
            },
          );
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
                  report: "KM Code restored the native snapshot.",
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
        if (nativeResumeCursor !== undefined && nativeSessionId !== nativeResumeCursor.sessionId) {
          return yield* new ProviderAdapterRequestError({
            provider: config.provider,
            method: "get_state",
            detail: `${config.runtime.toUpperCase()} resumed '${nativeSessionId}' instead of '${nativeResumeCursor.sessionId}'.`,
            reason: "protocol",
          });
        }
        const modelId = nativeModelSlug(state?.model);
        bindNativeSessionIdentity(session, config.runtime, nativeSessionId, modelId, false);
        if (config.runtime === "pi") {
          const response = yield* request(session, { type: "get_commands" }, "get_commands");
          yield* updateCommandCatalog(session, asRecord(response.data)?.commands);
        }
        session.startupComplete = true;
        yield* offer({
          ...session.runtimeEvents.base({ type: "session.started", id: input.threadId }),
          type: "session.started",
          payload: { message: `Started native ${config.runtime} session` },
        });
        if (session.slashCommands !== undefined) {
          yield* offerCommandCatalog(session, session.slashCommands);
        }
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
        const turnId = TurnId.make(nextNativeId());
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
                session.interruptedTurnIds.add(requestedTurnId);
              }
            });
            for (const [requestId, kind] of session.uiRequestKinds) {
              yield* Effect.ignore(
                send(session, {
                  type: "extension_ui_response",
                  id: requestId,
                  cancelled: true,
                }),
              );
              if (kind === "select" || kind === "askDialog") {
                yield* offer({
                  ...session.runtimeEvents.base(undefined, false),
                  type: "user-input.resolved",
                  requestId: RuntimeRequestId.make(requestId),
                  payload: { answers: {} },
                });
              } else {
                yield* offer({
                  ...session.runtimeEvents.base(undefined, false),
                  type: "request.resolved",
                  requestId: RuntimeRequestId.make(requestId),
                  payload: {
                    requestType:
                      kind === "confirm" ? "command_execution_approval" : "tool_user_input",
                    decision: "cancel",
                  },
                });
              }
            }
            session.uiRequestKinds.clear();

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
            if (requestKind === "select" || requestKind === "askDialog") {
              yield* offer({
                ...session.runtimeEvents.base(undefined, false),
                type: "user-input.resolved",
                requestId: RuntimeRequestId.make(requestId),
                payload: { answers: {} },
              });
            } else {
              yield* offer({
                ...session.runtimeEvents.base(undefined, false),
                type: "request.resolved",
                requestId: RuntimeRequestId.make(requestId),
                payload: {
                  requestType:
                    requestKind === "confirm" ? "command_execution_approval" : "tool_user_input",
                  decision,
                },
              });
            }
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
            const kind = session.uiRequestKinds.get(requestId);
            yield* send(session, {
              type: "extension_ui_response",
              id: requestId,
              value: nativeInputValue(answers),
              ...(kind === "askDialog" ? { answers } : {}),
            });
            session.uiRequestKinds.delete(requestId);
            if (kind === "input" || kind === "editor") {
              yield* offer({
                ...session.runtimeEvents.base(undefined, false),
                type: "request.resolved",
                requestId: RuntimeRequestId.make(requestId),
                payload: {
                  requestType: "tool_user_input",
                  decision: "accept",
                },
              });
            } else {
              yield* offer({
                ...session.runtimeEvents.base(undefined, false),
                type: "user-input.resolved",
                requestId: RuntimeRequestId.make(requestId),
                payload: { answers },
              });
            }
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
    const offlineHistoryCache = new Map<string, ReadonlyArray<ProviderNativeHistoryMessage>>();
    const readNativeHistoryBySession = (input: {
      readonly sessionId: string;
      readonly cwd: string;
      readonly cursor?: string;
    }): Effect.Effect<ProviderNativeHistoryPage, ProviderNativeSessionError> => {
      const cacheKey = `${config.instanceId}:${input.sessionId}`;
      if (input.cursor === undefined) {
        offlineHistoryCache.delete(cacheKey);
      }
      const cached = offlineHistoryCache.get(cacheKey);
      if (cached !== undefined && input.cursor !== undefined) {
        return pageNativeHistory(cached, input.cursor, 1024);
      }
      return readPiFamilyNativeHistoryMessages(config, input.sessionId, input.cwd).pipe(
        Effect.tap((messages) =>
          Effect.sync(() => {
            offlineHistoryCache.set(cacheKey, messages);
          }),
        ),
        Effect.flatMap((messages) => pageNativeHistory(messages, input.cursor, 1024)),
      );
    };
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
        if (cursor === undefined) {
          delete session.nativeHistoryMessages;
        }
        const messages =
          session.nativeHistoryMessages ??
          (yield* readPiFamilyNativeHistoryMessages(
            config,
            sessionId,
            session.session.cwd ?? config.cwd,
          ));
        session.nativeHistoryMessages = messages;
        return yield* pageNativeHistory(messages, cursor, 1024);
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
        const readFromNativeRpc: Effect.Effect<
          ProviderSubagentTranscriptReadResult,
          ProviderAdapterRequestError | ProviderNativeSessionError
        > = request(
          session,
          { type: "get_subagent_messages", subagentId, fromByte },
          "get_subagent_messages",
        ).pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<ProviderSubagentTranscriptReadResult, ProviderNativeSessionError> => {
              const transcript = transcriptEntriesFromResponse(response);
              return transcript === undefined
                ? Effect.fail(
                    new ProviderNativeSessionError({
                      code: "native",
                      message: "OMP returned an invalid subagent transcript response.",
                    }),
                  )
                : Effect.succeed(transcript);
            },
          ),
        );
        const readFromNativeCatalog = (
          nativeError_: ProviderAdapterRequestError,
        ): Effect.Effect<
          ProviderSubagentTranscriptReadResult,
          ProviderAdapterRequestError | ProviderNativeSessionError
        > => {
          const parentSessionId = session.nativeSessionId;
          if (parentSessionId === undefined) return Effect.fail(nativeError_);
          return readPiFamilyNativeSubagentTranscript(
            config,
            parentSessionId,
            subagentId,
            session.session.cwd ?? config.cwd,
            cursor,
          ).pipe(
            Effect.mapError((catalogError) =>
              catalogError.code === "not_found" ? nativeError_ : catalogError,
            ),
          );
        };
        return yield* readFromNativeRpc.pipe(
          Effect.catchTag("ProviderAdapterRequestError", readFromNativeCatalog),
        );
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
            ? { type: "checkpoint", goal: "KM Code filesystem checkpoint", mode: "snapshot" }
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
              report: "KM Code restored the filesystem checkpoint.",
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
      discoverNativeCommands,
      readNativeHistory,
      readNativeHistoryBySession,
      readSubagentTranscript,
      readSubagentTranscriptBySession: (input) =>
        readPiFamilyNativeSubagentTranscript(
          config,
          input.sessionId,
          input.subagentId,
          input.cwd,
          input.cursor,
        ),
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
