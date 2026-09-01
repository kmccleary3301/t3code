import * as NodeCrypto from "node:crypto";

import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  type CanonicalTaskStatus,
  type JsonRecord,
  type NativeTaskSnapshot,
  type PiFamilyProjectedEvent,
  type PiFamilyRuntimeKind,
  type PortableUiRequest,
  type RpcEnvelope,
} from "./protocol.ts";

const TERMINAL_STATUSES = new Set<CanonicalTaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const DEFAULT_MAX_UNKNOWN_EVENTS = 128;
const DEFAULT_MAX_TASK_SNAPSHOTS = 512;
const MAX_NATIVE_IDENTITY_PART_LENGTH = 128;

function boundedNativeIdentityPart(value: string): string {
  if (value.length <= MAX_NATIVE_IDENTITY_PART_LENGTH) return value;
  const digest = NodeCrypto.createHash("sha256").update(value).digest("hex");
  return `${value.slice(0, 32)}~${digest}`;
}

const MAX_NATIVE_UI_CONTENT_CHARS = 16_384;

function plainNativeUiText(value: string): string {
  // Native widgets/statuses carry terminal styling. Browser surfaces need the text only.
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/gu, "").trim();
  return plain.length <= MAX_NATIVE_UI_CONTENT_CHARS
    ? plain
    : `${plain.slice(0, MAX_NATIVE_UI_CONTENT_CHARS)}\n…`;
}

export interface PiFamilyEventProjectorOptions {
  /**
   * Native events are intentionally open-ended. Keep a bounded diagnostic
   * window instead of retaining an unbounded stream in a long-lived session.
   */
  readonly maxUnknownEvents?: number;
  /** Bound task snapshots as well; terminal entries are evicted first. */
  readonly maxTaskSnapshots?: number;
}

export interface PiFamilyProjectorDiagnostics {
  readonly retainedUnknownEvents: number;
  readonly droppedUnknownEvents: number;
  readonly taskSnapshots: number;
  readonly activeTasks: number;
}

const PI_EVENT_TYPES: Readonly<Record<string, true>> = {
  agent_start: true,
  agent_end: true,
  agent_settled: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  prompt_result: true,
  bash_execution_update: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  host_task_started: true,
  host_task_progress: true,
  host_task_completed: true,
  host_task_failed: true,
  host_task_cancelled: true,
  queue_update: true,
  extension_ui_request: true,
  compaction_start: true,
  compaction_end: true,
  retry_start: true,
  retry_end: true,
};

const OMP_EVENT_TYPES: Readonly<Record<string, true>> = {
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  host_task_started: true,
  host_task_progress: true,
  host_task_completed: true,
  host_task_failed: true,
  host_task_cancelled: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  queue_update: true,
  compaction_start: true,
  compaction_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  retry_start: true,
  retry_end: true,
  auto_retry_start: true,
  auto_retry_end: true,
  retry_fallback_applied: true,
  retry_fallback_succeeded: true,
  prompt_result: true,
  subagent_lifecycle: true,
  subagent_progress: true,
  subagent_event: true,
  extension_ui_request: true,
  available_commands_update: true,
  host_tool_call: true,
  host_tool_cancel: true,
  host_uri_request: true,
  host_uri_cancel: true,
  extension_error: true,
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Returns a restart-stable identity for a native event. Explicit native
 * sequence/event ids win. Otherwise the canonical frame is the deterministic
 * identity and a per-identical-frame occurrence disambiguates repeated chunks
 * without coupling unique frames to unrelated prior traffic.
 */
export function nativeEventId(
  runtime: PiFamilyRuntimeKind,
  event: RpcEnvelope,
  occurrence?: number,
): string {
  const eventType = boundedNativeIdentityPart(event.type);
  const explicit =
    asString(event.eventId) ??
    asString(event.event_id) ??
    (asNumber(event.sequence) ?? asNumber(event.seq))?.toString() ??
    asString(event.id);
  if (explicit !== undefined) {
    return `${runtime}:${eventType}:${boundedNativeIdentityPart(explicit)}`;
  }
  let hash = 2_166_261;
  for (const character of stableJson(event))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  const fallback = `${runtime}:${eventType}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  return occurrence === undefined ? fallback : `${fallback}:seq:${occurrence}`;
}

export class PiFamilyEventProjector {
  private readonly taskState = new Map<string, NativeTaskSnapshot>();
  private readonly taskParents = new Map<string, string>();
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly taskByToolCall = new Map<string, string>();
  private readonly pendingSettlement = new Map<string, CanonicalTaskStatus>();
  private readonly unknownEvents: RpcEnvelope[] = [];
  private readonly runtime: PiFamilyRuntimeKind;
  private readonly maxUnknownEvents: number;
  private readonly maxTaskSnapshots: number;
  private droppedUnknownEvents = 0;
  private activeTurnRequestId: string | undefined;
  private ompTurnSettledByMessage = false;

  public constructor(runtime: PiFamilyRuntimeKind, options: PiFamilyEventProjectorOptions = {}) {
    this.runtime = runtime;
    this.maxUnknownEvents = Math.max(
      1,
      Math.floor(options.maxUnknownEvents ?? DEFAULT_MAX_UNKNOWN_EVENTS),
    );
    this.maxTaskSnapshots = Math.max(
      1,
      Math.floor(options.maxTaskSnapshots ?? DEFAULT_MAX_TASK_SNAPSHOTS),
    );
  }

  public project(event: RpcEnvelope): PiFamilyProjectedEvent[] {
    if (!this.isKnownEvent(event.type)) {
      this.retainUnknown(event);
      return [{ kind: "runtime.raw", event }];
    }

    if (event.type === "agent_start" || event.type === "turn_start") {
      if (this.runtime === "omp" && event.type === "turn_start") return [];
      const requestId = this.eventRequestId(event) ?? this.activeTurnRequestId;
      this.activeTurnRequestId = requestId;
      if (this.runtime === "omp") this.ompTurnSettledByMessage = false;
      return [{ kind: "turn.started", ...(requestId ? { requestId } : {}), raw: event }];
    }
    // Pi's turn_end and agent_end precede agent_settled. Neither is proof that
    // retries, compaction, and extension work have quiesced.
    if (event.type === "turn_end" || (this.runtime === "pi" && event.type === "agent_end")) {
      return [];
    }
    if (event.type === "agent_settled") {
      const requestId = this.eventRequestId(event) ?? this.activeTurnRequestId;
      this.activeTurnRequestId = undefined;
      this.ompTurnSettledByMessage = false;
      return [{ kind: "turn.settled", ...(requestId ? { requestId } : {}), raw: event }];
    }
    if (event.type === "agent_end") {
      if (!this.isTerminalAgentEnd(event)) {
        this.retainUnknown(event, "OMP agent_end is a non-terminal retry/pause");
        return [{ kind: "runtime.raw", event }];
      }
      if (this.ompTurnSettledByMessage) {
        this.activeTurnRequestId = undefined;
        this.ompTurnSettledByMessage = false;
        return [];
      }
      const requestId = this.eventRequestId(event) ?? this.activeTurnRequestId;
      this.activeTurnRequestId = undefined;
      return [{ kind: "turn.settled", ...(requestId ? { requestId } : {}), raw: event }];
    }
    if (event.type === "prompt_result") {
      const source = asRecord(event);
      const outcome = asString(source?.outcome);
      const requestId = this.eventRequestId(event);
      if (outcome === "handled" || source?.agentInvoked === false) {
        this.activeTurnRequestId = undefined;
        return [{ kind: "turn.settled", ...(requestId ? { requestId } : {}), raw: event }];
      }
      if (source?.agentInvoked === true || outcome === "started" || outcome === "queued") {
        this.activeTurnRequestId = requestId;
      }
      this.retainUnknown(event, "prompt was accepted but agent execution remains pending");
      return [{ kind: "runtime.raw", event }];
    }
    if (event.type === "message_update") {
      const text = this.extractText(event);
      if (text === undefined) {
        this.retainUnknown(event, "known message event without text");
        return [{ kind: "runtime.raw", event }];
      }
      return [
        {
          kind: "message.delta",
          channel: this.isReasoning(event) ? "reasoning" : "assistant",
          text,
          raw: event,
        },
      ];
    }
    if (event.type === "message_end") {
      if (!this.isTerminalAssistantMessage(event)) {
        this.retainUnknown(event, "known message_end without a terminal assistant payload");
        return [{ kind: "runtime.raw", event }];
      }
      const completed: PiFamilyProjectedEvent = { kind: "message.completed", raw: event };
      if (this.runtime !== "omp") return [completed];
      const requestId = this.eventRequestId(event) ?? this.activeTurnRequestId;
      this.ompTurnSettledByMessage = true;
      return [completed, { kind: "turn.settled", ...(requestId ? { requestId } : {}), raw: event }];
    }
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      const phase =
        event.type === "tool_execution_start"
          ? "tool.started"
          : event.type === "tool_execution_update"
            ? "tool.progress"
            : "tool.completed";
      const tool = { kind: phase, ...this.toolFields(event), raw: event } as const;
      const plan = event.type === "tool_execution_end" ? this.projectTodoPlan(event) : undefined;
      return plan === undefined
        ? [tool]
        : [
            tool,
            {
              kind: "plan.updated",
              plan,
              ...(this.activeTurnRequestId === undefined
                ? {}
                : { requestId: this.activeTurnRequestId }),
              raw: event,
            },
          ];
    }
    if (event.type === "bash_execution_update") {
      return [{ kind: "tool.progress", ...this.toolFields(event), raw: event }];
    }
    if (
      (this.runtime === "omp" &&
        (event.type === "subagent_lifecycle" ||
          event.type === "subagent_progress" ||
          event.type === "subagent_event")) ||
      event.type === "host_task_started" ||
      event.type === "host_task_progress" ||
      event.type === "host_task_completed" ||
      event.type === "host_task_failed" ||
      event.type === "host_task_cancelled"
    ) {
      const projected = this.projectTask(event);
      return event.type === "subagent_event"
        ? [...projected, ...this.projectNestedOmpTasks(event)]
        : projected;
    }
    if (event.type === "queue_update") return [{ kind: "queue.changed", raw: event }];
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      return [{ kind: "compaction.started", raw: event }];
    }
    if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
      return [{ kind: "compaction.completed", raw: event }];
    }
    if (
      event.type === "retry_start" ||
      event.type === "retry_end" ||
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end" ||
      event.type === "retry_fallback_applied" ||
      event.type === "retry_fallback_succeeded"
    ) {
      return [{ kind: "retry.scheduled", raw: event }];
    }

    const ui = this.projectUi(event);
    if (ui) return [{ kind: "ui.request", request: ui, raw: event }];
    // Keep known-but-not-yet-portable events diagnosable without pretending
    // they were mapped to a canonical operation.
    this.retainUnknown(event, "known event has no portable projection");
    return [{ kind: "runtime.raw", event }];
  }

  public snapshotTasks(): NativeTaskSnapshot[] {
    return [...this.taskState.values()].map((task) => structuredClone(task));
  }

  public snapshotUnknownEvents(): RpcEnvelope[] {
    return this.unknownEvents.map((event) => structuredClone(event));
  }

  public diagnostics(): PiFamilyProjectorDiagnostics {
    let activeTasks = 0;
    for (const task of this.taskState.values()) {
      if (!TERMINAL_STATUSES.has(task.status)) activeTasks += 1;
    }
    return {
      retainedUnknownEvents: this.unknownEvents.length,
      droppedUnknownEvents: this.droppedUnknownEvents,
      taskSnapshots: this.taskState.size,
      activeTasks,
    };
  }

  private isKnownEvent(type: string): boolean {
    return (this.runtime === "pi" ? PI_EVENT_TYPES : OMP_EVENT_TYPES)[type] === true;
  }

  private retainUnknown(event: RpcEnvelope, _reason?: string): void {
    this.unknownEvents.push(structuredClone(event));
    while (this.unknownEvents.length > this.maxUnknownEvents) {
      this.unknownEvents.shift();
      this.droppedUnknownEvents += 1;
    }
  }

  private eventRequestId(event: RpcEnvelope): string | undefined {
    const source = asRecord(event.payload) ?? asRecord(event.data);
    return (
      asString(event.requestId) ??
      asString(event.turnId) ??
      asString(event.id) ??
      asString(source?.requestId) ??
      asString(source?.turnId) ??
      asString(source?.id)
    );
  }
  private projectNestedOmpTasks(event: RpcEnvelope): PiFamilyProjectedEvent[] {
    const payload = asRecord(event.payload);
    const nestedEvent = asRecord(payload?.event);
    if (nestedEvent?.type !== "tool_execution_update" || nestedEvent.toolName !== "task") {
      return [];
    }
    const partialResult = asRecord(nestedEvent.partialResult);
    const details = asRecord(partialResult?.details);
    const progress = Array.isArray(details?.progress) ? details.progress : [];
    const parentTaskId = asString(payload?.id);
    const parentToolCallId = asString(nestedEvent.toolCallId) ?? asString(nestedEvent.tool_call_id);
    if (parentTaskId === undefined) return [];
    return progress.flatMap((candidate) => {
      const task = asRecord(candidate);
      const taskId = asString(task?.id);
      if (task === undefined || taskId === undefined || taskId === parentTaskId) return [];
      return this.projectTask({
        type: "subagent_progress",
        payload: {
          ...task,
          id: taskId,
          parentId: parentTaskId,
          ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
        },
      });
    });
  }

  private projectTask(event: RpcEnvelope): PiFamilyProjectedEvent[] {
    const payload = asRecord(event.payload);
    const data = asRecord(event.data);
    const nestedTask = asRecord(payload?.task) ?? asRecord(data?.task) ?? asRecord(event.task);
    const nestedProgress =
      asRecord(payload?.progress) ?? asRecord(data?.progress) ?? asRecord(event.progress);
    const source: JsonRecord = {
      ...event,
      ...data,
      ...payload,
      ...nestedProgress,
      ...nestedTask,
    };
    const id =
      asString(source.id) ??
      asString(source.subagentId) ??
      asString(source.taskId) ??
      asString(source.task_id) ??
      asString(event.id) ??
      `task-${nativeEventId(this.runtime, event)}`;
    const previous = this.taskState.get(id);
    const nativeStatus = this.taskStatus(event.type, source, previous?.status);
    const parentToolCallId =
      asString(source.parentToolCallId) ??
      asString(source.parent_tool_call_id) ??
      asString(source.parentToolUseId) ??
      asString(source.parent_tool_use_id) ??
      asString(source.parentToolCall) ??
      previous?.parentToolCallId;
    const taskToolCallId = asString(source.toolCallId) ?? asString(source.tool_call_id);
    const explicitParentTaskId =
      asString(source.parentTaskId) ??
      asString(source.parent_task_id) ??
      asString(source.parentId) ??
      asString(source.parent_id) ??
      previous?.parentTaskId;
    const parentTaskId =
      explicitParentTaskId ??
      (parentToolCallId ? this.taskByToolCall.get(parentToolCallId) : undefined);
    const existingChildren = this.childrenByParent.get(id);
    const hasActiveChildren =
      existingChildren !== undefined &&
      [...existingChildren].some((childId) => {
        const child = this.taskState.get(childId);
        return child !== undefined && !TERMINAL_STATUSES.has(child.status);
      });
    const holdingParentSettlement = TERMINAL_STATUSES.has(nativeStatus) && hasActiveChildren;
    const status = holdingParentSettlement ? "waiting" : nativeStatus;

    if (previous && TERMINAL_STATUSES.has(previous.status) && !TERMINAL_STATUSES.has(status)) {
      this.retainUnknown(event, "late non-terminal task event");
      return [{ kind: "runtime.raw", event }];
    }

    const usage = asRecord(source.usage) ?? asRecord(source.metrics);
    const inputTokens = usage ? (asNumber(usage.inputTokens) ?? asNumber(usage.input)) : undefined;
    const outputTokens = usage
      ? (asNumber(usage.outputTokens) ?? asNumber(usage.output))
      : undefined;
    const cachedInputTokens = usage
      ? (asNumber(usage.cachedInputTokens) ?? asNumber(usage.cacheRead))
      : undefined;
    const contextTokens =
      (usage ? (asNumber(usage.contextTokens) ?? asNumber(usage.context)) : undefined) ??
      asNumber(source.contextTokens);
    const costUsd =
      (usage ? (asNumber(usage.costUsd) ?? asNumber(usage.cost)) : undefined) ??
      asNumber(source.costUsd) ??
      asNumber(source.cost);
    const durationMs =
      (usage ? (asNumber(usage.durationMs) ?? asNumber(usage.duration)) : undefined) ??
      asNumber(source.durationMs);
    const toolCalls = (usage ? asNumber(usage.toolCalls) : undefined) ?? asNumber(source.toolCount);
    const usageSnapshot =
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      contextTokens !== undefined ||
      costUsd !== undefined ||
      durationMs !== undefined ||
      toolCalls !== undefined
        ? {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            ...(contextTokens === undefined ? {} : { contextTokens }),
            ...(costUsd === undefined ? {} : { costUsd }),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(toolCalls === undefined ? {} : { toolCalls }),
          }
        : undefined;
    const nextUsage = usageSnapshot ?? previous?.usage;
    const role = asString(source.role) ?? asString(source.agent) ?? previous?.role;
    const description =
      asString(source.description) ??
      asString(source.assignment) ??
      asString(source.task) ??
      previous?.description;
    const currentActivity =
      asString(source.currentActivity) ?? asString(source.activity) ?? previous?.currentActivity;
    const lastToolName =
      asString(source.lastToolName) ?? asString(source.toolName) ?? previous?.lastToolName;
    const model = asString(source.model) ?? asString(source.resolvedModel) ?? previous?.model;
    const fallbackModel = asString(source.fallbackModel) ?? previous?.fallbackModel;
    const attempt = asNumber(source.attempt) ?? previous?.attempt;
    const workflowRecord = asRecord(source.workflow) ?? asRecord(source.workflowMetadata);
    const workflow = (() => {
      const existing = previous?.workflow;
      const name = asString(workflowRecord?.name) ?? existing?.name;
      const phaseIndex = asNumber(workflowRecord?.phaseIndex) ?? existing?.phaseIndex;
      const phaseTitle = asString(workflowRecord?.phaseTitle) ?? existing?.phaseTitle;
      const agentIndex = asNumber(workflowRecord?.agentIndex) ?? existing?.agentIndex;
      if (
        existing === undefined &&
        name === undefined &&
        phaseIndex === undefined &&
        phaseTitle === undefined &&
        agentIndex === undefined
      ) {
        return undefined;
      }
      return {
        ...(name === undefined ? {} : { name }),
        ...(phaseIndex === undefined ? {} : { phaseIndex }),
        ...(phaseTitle === undefined ? {} : { phaseTitle }),
        ...(agentIndex === undefined ? {} : { agentIndex }),
      } as NonNullable<NativeTaskSnapshot["workflow"]>;
    })();
    const explicitRunHandles = asRecord(source.runHandles) ?? asRecord(source.execution);
    const runHandles = (() => {
      const runId =
        asString(source.runId) ??
        asString(explicitRunHandles?.runId) ??
        previous?.runHandles?.runId;
      const sessionFile =
        asString(source.sessionFile) ??
        asString(explicitRunHandles?.sessionFile) ??
        previous?.runHandles?.sessionFile;
      const outputPath =
        asString(source.outputPath) ??
        asString(explicitRunHandles?.outputPath) ??
        previous?.runHandles?.outputPath;
      const patchPath =
        asString(source.patchPath) ??
        asString(explicitRunHandles?.patchPath) ??
        previous?.runHandles?.patchPath;
      const worktreePath =
        asString(source.worktreePath) ??
        asString(explicitRunHandles?.worktreePath) ??
        previous?.runHandles?.worktreePath;
      const branch =
        asString(source.branchName) ??
        asString(source.branch) ??
        asString(explicitRunHandles?.branch) ??
        previous?.runHandles?.branch;
      const jobId =
        asString(source.jobId) ??
        asString(explicitRunHandles?.jobId) ??
        previous?.runHandles?.jobId;
      if (
        explicitRunHandles === undefined &&
        runId === undefined &&
        sessionFile === undefined &&
        outputPath === undefined &&
        patchPath === undefined &&
        worktreePath === undefined &&
        branch === undefined &&
        jobId === undefined
      )
        return previous?.runHandles;
      return {
        ...previous?.runHandles,
        ...explicitRunHandles,
        ...(runId === undefined ? {} : { runId }),
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(outputPath === undefined ? {} : { outputPath }),
        ...(patchPath === undefined ? {} : { patchPath }),
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(branch === undefined ? {} : { branch }),
        ...(jobId === undefined ? {} : { jobId }),
      };
    })();
    const summary = asString(source.summary) ?? asString(source.result) ?? previous?.summary;
    const error =
      asString(source.error) ?? asString(asRecord(source.error)?.message) ?? previous?.error;
    const detached =
      asBoolean(source.detached) ?? asBoolean(source.background) ?? previous?.detached;
    const metadata = asRecord(source.metadata) ?? previous?.metadata;
    const snapshot: NativeTaskSnapshot = {
      id,
      kind:
        asString(source.kind) ??
        asString(source.taskType) ??
        asString(source.task_type) ??
        previous?.kind ??
        "subagent",
      title: asString(source.title) ?? description ?? previous?.title ?? id,
      status,
      ...(parentTaskId === undefined ? {} : { parentTaskId }),
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      ...(role === undefined ? {} : { role }),
      ...(description === undefined ? {} : { description }),
      ...(currentActivity === undefined ? {} : { currentActivity }),
      ...(lastToolName === undefined ? {} : { lastToolName }),
      ...(model === undefined ? {} : { model }),
      ...(fallbackModel === undefined ? {} : { fallbackModel }),
      ...(workflow === undefined ? {} : { workflow }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(nextUsage ? { usage: nextUsage } : {}),
      ...(runHandles === undefined ? {} : { runHandles }),
      ...(summary === undefined ? {} : { summary }),
      ...(error === undefined ? {} : { error }),
      ...(detached === undefined ? {} : { detached }),
      ...(metadata === undefined ? {} : { metadata }),
    };

    this.updateHierarchy(id, parentTaskId, taskToolCallId);
    this.taskState.set(id, snapshot);
    if (holdingParentSettlement) this.pendingSettlement.set(id, nativeStatus);
    else this.pendingSettlement.delete(id);
    this.trimTaskState();

    const projected: PiFamilyProjectedEvent[] = [
      {
        kind: !previous
          ? "task.started"
          : TERMINAL_STATUSES.has(status)
            ? "task.completed"
            : "task.progress",
        task: snapshot,
        raw: event,
      },
    ];
    if (!holdingParentSettlement && TERMINAL_STATUSES.has(status)) {
      this.appendSettledParents(projected, id, event);
    }
    return projected;
  }

  private updateHierarchy(
    id: string,
    parentTaskId: string | undefined,
    taskToolCallId: string | undefined,
  ): void {
    const oldParent = this.taskParents.get(id);
    if (oldParent !== undefined && oldParent !== parentTaskId)
      this.childrenByParent.get(oldParent)?.delete(id);
    if (parentTaskId === undefined) this.taskParents.delete(id);
    else {
      this.taskParents.set(id, parentTaskId);
      const children = this.childrenByParent.get(parentTaskId) ?? new Set<string>();
      children.add(id);
      this.childrenByParent.set(parentTaskId, children);
    }
    if (taskToolCallId !== undefined) this.taskByToolCall.set(taskToolCallId, id);
  }

  private appendSettledParents(
    projected: PiFamilyProjectedEvent[],
    childId: string,
    raw: RpcEnvelope,
  ): void {
    const visited = new Set<string>();
    let parentId = this.taskParents.get(childId);
    while (parentId !== undefined) {
      if (visited.has(parentId)) {
        this.retainUnknown(raw, "cyclic task parent hierarchy");
        break;
      }
      visited.add(parentId);
      const pendingStatus = this.pendingSettlement.get(parentId);
      const children = this.childrenByParent.get(parentId);
      const hasActiveChildren =
        children !== undefined &&
        [...children].some((id) => {
          const task = this.taskState.get(id);
          return task !== undefined && !TERMINAL_STATUSES.has(task.status);
        });
      if (pendingStatus === undefined || hasActiveChildren) break;
      const parent = this.taskState.get(parentId);
      if (parent === undefined) break;
      const settledParent: NativeTaskSnapshot = { ...parent, status: pendingStatus };
      this.taskState.set(parentId, settledParent);
      this.pendingSettlement.delete(parentId);
      projected.push({ kind: "task.completed", task: settledParent, raw });
      parentId = this.taskParents.get(parentId);
    }
  }
  private trimTaskState(): void {
    while (this.taskState.size > this.maxTaskSnapshots) {
      const candidate = [...this.taskState.entries()].find(([, task]) =>
        TERMINAL_STATUSES.has(task.status),
      );
      const id = candidate?.[0] ?? this.taskState.keys().next().value;
      if (id === undefined) break;
      this.taskState.delete(id);
      this.pendingSettlement.delete(id);
      const parentId = this.taskParents.get(id);
      if (parentId !== undefined) this.childrenByParent.get(parentId)?.delete(id);
      this.taskParents.delete(id);
    }
  }

  private taskStatus(
    type: string,
    source: JsonRecord,
    previous?: CanonicalTaskStatus,
  ): CanonicalTaskStatus {
    const explicit = asString(source.status)?.toLowerCase();
    if (
      explicit === "pending" ||
      explicit === "running" ||
      explicit === "waiting" ||
      explicit === "idle" ||
      explicit === "completed" ||
      explicit === "failed" ||
      explicit === "cancelled" ||
      explicit === "interrupted"
    )
      return explicit;
    if (explicit === "aborted" || explicit === "canceled" || explicit === "stopped")
      return "cancelled";
    if (type === "host_task_completed") return "completed";
    if (type === "host_task_failed") return "failed";
    if (type === "host_task_cancelled") return "cancelled";
    if (
      type === "subagent_lifecycle" ||
      type === "subagent_progress" ||
      type === "subagent_event" ||
      type === "host_task_started" ||
      type === "host_task_progress"
    )
      return previous ?? "running";
    return previous ?? "running";
  }

  private projectUi(event: RpcEnvelope): PortableUiRequest | undefined {
    if (event.type !== "extension_ui_request") return undefined;
    const source = asRecord(event);
    const method = asString(source?.method);
    const requestId = asString(source?.id);
    if (!method || !requestId) return undefined;
    if (method === "select") {
      const rawOptions = Array.isArray(source?.options) ? source.options : [];
      const options = rawOptions.map((option, index) => {
        if (typeof option === "string") return { id: option, label: option };
        const record = asRecord(option);
        const id = asString(record?.id) ?? asString(record?.value) ?? String(index);
        const label = asString(record?.label) ?? asString(record?.title) ?? String(index);
        const description = asString(record?.description);
        return description === undefined ? { id, label } : { id, label, description };
      });
      const title = asString(source?.title);
      return { kind: "select", requestId, ...(title === undefined ? {} : { title }), options };
    }
    if (method === "confirm") {
      const title = asString(source?.title);
      return {
        kind: "confirm",
        requestId,
        ...(title === undefined ? {} : { title }),
        message: asString(source?.message) ?? "Confirm?",
      };
    }
    if (method === "input" || method === "editor") {
      const title = asString(source?.title);
      const initialValue = asString(source?.prefill);
      const placeholder = asString(source?.placeholder);
      return {
        kind: method,
        requestId,
        ...(title === undefined ? {} : { title }),
        ...(initialValue === undefined ? {} : { initialValue }),
        ...(placeholder === undefined ? {} : { placeholder }),
      };
    }
    if (method === "notify") {
      const level = asString(source?.notifyType);
      return {
        kind: "notify",
        requestId,
        message: asString(source?.message) ?? "",
        ...(level === "info" || level === "success" || level === "warning" || level === "error"
          ? { level }
          : {}),
      };
    }
    if (method === "setStatus") {
      const value = asString(source?.statusText);
      const plainValue = value === undefined ? undefined : plainNativeUiText(value);
      return {
        kind: "status",
        requestId,
        key: asString(source?.statusKey) ?? "native",
        ...(plainValue === undefined || plainValue === "" ? {} : { value: plainValue }),
      };
    }
    if (method === "setWidget") {
      const placement = source?.widgetPlacement === "aboveEditor" ? "above" : "below";
      const widgetLines = Array.isArray(source?.widgetLines)
        ? source.widgetLines.filter((line): line is string => typeof line === "string")
        : undefined;
      const content =
        widgetLines === undefined ? undefined : plainNativeUiText(widgetLines.join("\n"));
      return {
        kind: "widget",
        requestId,
        key: asString(source?.widgetKey) ?? "native",
        placement,
        ...(content === undefined || content === "" ? {} : { content }),
      };
    }
    if (method === "open_url") {
      const url = asString(source?.url);
      return url ? { kind: "open_url", requestId, url, purpose: "external" } : undefined;
    }
    if (method === "cancel" || method === "setTitle" || method === "set_editor_text") {
      return {
        kind: "unsupported_terminal_ui",
        requestId,
        feature: method,
        message: "This UI operation is not host-portable",
      };
    }
    return undefined;
  }

  private projectTodoPlan(
    event: RpcEnvelope,
  ):
    | readonly { readonly step: string; readonly status: "pending" | "inProgress" | "completed" }[]
    | undefined {
    if (asString(event.toolName) !== "todo" || event.isError === true) return undefined;
    const result = asRecord(event.result);
    const details = asRecord(result?.details);
    if (!Array.isArray(details?.phases)) return undefined;
    const phases = details.phases.flatMap((value) => {
      const phase = asRecord(value);
      const name = asString(phase?.name)?.trim();
      const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
      return name === undefined || name === "" ? [] : [{ name, tasks }];
    });
    const prefixPhase = phases.length > 1;
    return phases.flatMap((phase) =>
      phase.tasks.flatMap((value) => {
        const task = asRecord(value);
        const content = asString(task?.content)?.trim();
        const nativeStatus = asString(task?.status);
        if (content === undefined || content === "" || nativeStatus === "abandoned") return [];
        const blocker = asString(task?.blocker)?.trim();
        const blockedSuffix =
          nativeStatus === "blocked" ? (blocker ? ` — blocked: ${blocker}` : " — blocked") : "";
        return [
          {
            step: `${prefixPhase ? `${phase.name} · ` : ""}${content}${blockedSuffix}`,
            status:
              nativeStatus === "completed"
                ? ("completed" as const)
                : nativeStatus === "in_progress"
                  ? ("inProgress" as const)
                  : ("pending" as const),
          },
        ];
      }),
    );
  }

  private toolFields(event: RpcEnvelope): { readonly toolCallId?: string; readonly name?: string } {
    const toolCallId = asString(event.toolCallId) ?? asString(event.id);
    const name = asString(event.toolName);
    return {
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(name === undefined ? {} : { name }),
    };
  }

  private isTerminalAgentEnd(event: RpcEnvelope): boolean {
    const isTerminal = asBoolean(event.isTerminal) ?? asBoolean(event.is_terminal);
    if (isTerminal !== undefined) return isTerminal;
    const willContinue = asBoolean(event.willContinue) ?? asBoolean(event.will_continue);
    return willContinue === false;
  }

  private isTerminalAssistantMessage(event: RpcEnvelope): boolean {
    const message =
      asRecord(event.message) ?? asRecord(event.assistantMessage) ?? asRecord(event.data);
    const explicit =
      asBoolean(message?.isTerminal) ??
      asBoolean(message?.is_terminal) ??
      asBoolean(event.isTerminal) ??
      asBoolean(event.is_terminal);
    if (explicit !== undefined) return explicit;
    const stopReason =
      asString(message?.stopReason) ??
      asString(message?.stop_reason) ??
      asString(event.stopReason) ??
      asString(event.stop_reason);
    return (
      stopReason === "stop" ||
      stopReason === "error" ||
      stopReason === "aborted" ||
      stopReason === "cancelled" ||
      stopReason === "canceled" ||
      stopReason === "length"
    );
  }

  private extractText(event: RpcEnvelope): string | undefined {
    const assistantEvent = asRecord(event.assistantMessageEvent);
    if (assistantEvent?.type === "text_delta") return asString(assistantEvent.delta);
    const sources = [asRecord(event.delta), asRecord(event.message), asRecord(event.data), event];
    for (const source of sources) {
      const direct = asString(source?.text);
      if (direct !== undefined) return direct;
      const content = source?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            const record = asRecord(part);
            return (
              asString(record?.text) ??
              (record?.type === "text" ? asString(record?.content) : undefined)
            );
          })
          .filter((part): part is string => part !== undefined)
          .join("");
        if (text.length > 0) return text;
      }
    }
    return asString(event.text);
  }

  private isReasoning(event: RpcEnvelope): boolean {
    const assistantEvent = asRecord(event.assistantMessageEvent);
    const source = assistantEvent ?? asRecord(event.delta) ?? asRecord(event.message) ?? event;
    const channel =
      asString(source?.channel) ??
      asString(source?.kind) ??
      asString(source?.role) ??
      asString(source?.type);
    return (
      channel === "reasoning" ||
      channel === "thinking" ||
      channel === "analysis" ||
      channel === "thinking_delta"
    );
  }
}
