import { RuntimeTaskId, type TaskProgressPayload } from "@t3tools/contracts";

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
  type RpcEnvelope,
} from "./protocol.ts";
import { nativeEventId } from "./NativeEventIdentity.ts";

const TERMINAL_STATUSES = new Set<CanonicalTaskStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const DEFAULT_MAX_TASK_SNAPSHOTS = 512;

export interface NativeTaskProjectorOptions {
  /** Bound terminal task snapshots; active tasks may exceed this cap to preserve hierarchy. */
  readonly maxTaskSnapshots?: number;
}

/** The event projector retains diagnostics while this owner mutates task state. */
export interface NativeTaskProjectorHost {
  readonly retainUnknown: (event: RpcEnvelope, reason?: string) => void;
}

export interface NativeTaskProjectorDiagnostics {
  readonly taskSnapshots: number;
  readonly activeTasks: number;
}

const NOOP_TASK_PROJECTOR_HOST: NativeTaskProjectorHost = {
  retainUnknown: () => undefined,
};

/** Map one native snapshot to the canonical task progress payload. */
export function nativeTaskLifecyclePayload(task: NativeTaskSnapshot): TaskProgressPayload {
  const description = task.description ?? task.title ?? task.id;
  const handles = task.runHandles;
  const runHandles =
    handles === undefined
      ? undefined
      : {
          ...(typeof handles.runId === "string"
            ? { runId: handles.runId }
            : typeof handles.jobId === "string"
              ? { runId: handles.jobId }
              : {}),
          ...(typeof handles.scriptPath === "string" ? { scriptPath: handles.scriptPath } : {}),
          ...(typeof handles.transcriptDir === "string"
            ? { transcriptDir: handles.transcriptDir }
            : {}),
          ...(typeof handles.sessionUrl === "string" &&
          (handles.sessionUrl.startsWith("http://") || handles.sessionUrl.startsWith("https://"))
            ? { sessionUrl: handles.sessionUrl }
            : {}),
        };
  return {
    taskId: RuntimeTaskId.make(task.id),
    description,
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    ...(task.usage === undefined ? {} : { usage: task.usage }),
    ...(task.lastToolName === undefined ? {} : { lastToolName: task.lastToolName }),
    ...(task.status === undefined ? {} : { status: task.status }),
    ...(task.error === undefined ? {} : { error: task.error }),
    taskType: task.kind,
    ...(task.title === undefined ? {} : { title: task.title }),
    ...(task.role === undefined ? {} : { role: task.role }),
    ...(task.model === undefined ? {} : { model: task.model }),
    ...(task.parentToolCallId === undefined ? {} : { toolUseId: task.parentToolCallId }),
    ...(task.parentTaskId === undefined ? {} : { parentAgentId: task.parentTaskId }),
    ...(task.detached === undefined ? {} : { isBackgrounded: task.detached }),
    ...(task.workflow?.name === undefined ? {} : { workflowName: task.workflow.name }),
    ...(task.workflow?.phaseIndex === undefined ? {} : { phaseIndex: task.workflow.phaseIndex }),
    ...(task.workflow?.phaseTitle === undefined ? {} : { phaseTitle: task.workflow.phaseTitle }),
    ...(task.workflow?.agentIndex === undefined ? {} : { agentIndex: task.workflow.agentIndex }),
    ...(task.attempt === undefined ? {} : { attempt: task.attempt }),
    ...(runHandles === undefined || Object.keys(runHandles).length === 0 ? {} : { runHandles }),
  };
}
/**
 * Recover task snapshots embedded in persisted task-tool results. A task-tool
 * result is only a snapshot of native state: its status is copied verbatim and
 * no terminal state is inferred from the enclosing tool call.
 */
export function nativeTaskSnapshotsFromPersistedTool(
  runtime: PiFamilyRuntimeKind,
  raw: RpcEnvelope,
): ReadonlyArray<NativeTaskSnapshot> {
  const result = asRecord(raw.result) ?? asRecord(raw.partialResult) ?? asRecord(raw.output);
  const details = asRecord(result?.details);
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  if (progress.length === 0) return [];

  const projector = new NativeTaskProjector(runtime);
  const parentToolCallId = asString(raw.toolCallId) ?? asString(raw.id);
  for (const candidate of progress) {
    const task = asRecord(candidate);
    if (task === undefined || asString(task.id) === undefined) continue;
    const payload = {
      ...task,
      ...(parentToolCallId === undefined ||
      asString(task.parentToolCallId) !== undefined ||
      asString(task.parent_tool_call_id) !== undefined ||
      asString(task.parentToolUseId) !== undefined ||
      asString(task.parent_tool_use_id) !== undefined
        ? {}
        : { parentToolCallId }),
    };
    projector.project({
      type: runtime === "omp" ? "subagent_progress" : "host_task_progress",
      payload,
    });
  }
  return projector.snapshotTasks();
}

export class NativeTaskProjector {
  private readonly taskState = new Map<string, NativeTaskSnapshot>();
  private readonly childrenByParent = new Map<string, Set<string>>();
  private readonly taskByToolCall = new Map<string, string>();
  private readonly pendingSettlement = new Map<string, CanonicalTaskStatus>();
  private readonly runtime: PiFamilyRuntimeKind;
  private readonly maxTaskSnapshots: number;
  private readonly host: NativeTaskProjectorHost;

  public constructor(
    runtime: PiFamilyRuntimeKind,
    options: NativeTaskProjectorOptions = {},
    host: NativeTaskProjectorHost = NOOP_TASK_PROJECTOR_HOST,
  ) {
    this.runtime = runtime;
    this.maxTaskSnapshots = Math.max(
      1,
      Math.floor(options.maxTaskSnapshots ?? DEFAULT_MAX_TASK_SNAPSHOTS),
    );
    this.host = host;
  }

  public snapshotTasks(): NativeTaskSnapshot[] {
    return [...this.taskState.values()].map((task) => structuredClone(task));
  }

  public diagnostics(): NativeTaskProjectorDiagnostics {
    let activeTasks = 0;
    for (const task of this.taskState.values()) {
      if (!TERMINAL_STATUSES.has(task.status)) activeTasks += 1;
    }
    return {
      taskSnapshots: this.taskState.size,
      activeTasks,
    };
  }

  public projectNestedOmpTasks(event: RpcEnvelope): PiFamilyProjectedEvent[] {
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
      return this.project({
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

  public project(event: RpcEnvelope): PiFamilyProjectedEvent[] {
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
      asString(source.parent_id);
    const previousParentTaskId =
      previous?.parentTaskId !== undefined &&
      (this.taskState.has(previous.parentTaskId) ||
        this.childrenByParent.has(previous.parentTaskId))
        ? previous.parentTaskId
        : undefined;
    const parentTaskId =
      explicitParentTaskId ??
      (parentToolCallId !== undefined
        ? this.taskByToolCall.get(parentToolCallId)
        : previousParentTaskId);
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
      this.host.retainUnknown(event, "late non-terminal task event");
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
    let recentToolName: string | undefined;
    if (Array.isArray(source.recentTools)) {
      for (let index = source.recentTools.length - 1; index >= 0; index -= 1) {
        const recentTool = asRecord(source.recentTools[index]);
        recentToolName =
          asString(recentTool?.tool) ??
          asString(recentTool?.toolName) ??
          asString(recentTool?.name);
        if (recentToolName !== undefined) break;
      }
    }
    const lastToolName =
      asString(source.lastToolName) ??
      asString(source.toolName) ??
      recentToolName ??
      previous?.lastToolName;
    const model = asString(source.model) ?? asString(source.resolvedModel) ?? previous?.model;
    const fallbackModel = asString(source.fallbackModel) ?? previous?.fallbackModel;
    const attempt = asNumber(source.attempt) ?? previous?.attempt;
    const workflowRecord = asRecord(source.workflow) ?? asRecord(source.workflowMetadata);
    const existingWorkflow = previous?.workflow;
    const workflowName = asString(workflowRecord?.name) ?? existingWorkflow?.name;
    const workflowPhaseIndex = asNumber(workflowRecord?.phaseIndex) ?? existingWorkflow?.phaseIndex;
    const workflowPhaseTitle = asString(workflowRecord?.phaseTitle) ?? existingWorkflow?.phaseTitle;
    const workflowAgentIndex = asNumber(workflowRecord?.agentIndex) ?? existingWorkflow?.agentIndex;
    const workflow =
      existingWorkflow === undefined &&
      workflowName === undefined &&
      workflowPhaseIndex === undefined &&
      workflowPhaseTitle === undefined &&
      workflowAgentIndex === undefined
        ? undefined
        : {
            ...(workflowName === undefined ? {} : { name: workflowName }),
            ...(workflowPhaseIndex === undefined ? {} : { phaseIndex: workflowPhaseIndex }),
            ...(workflowPhaseTitle === undefined ? {} : { phaseTitle: workflowPhaseTitle }),
            ...(workflowAgentIndex === undefined ? {} : { agentIndex: workflowAgentIndex }),
          };
    const explicitRunHandles = asRecord(source.runHandles) ?? asRecord(source.execution);
    const runId =
      asString(source.runId) ?? asString(explicitRunHandles?.runId) ?? previous?.runHandles?.runId;
    const sessionFile =
      asString(source.sessionFile) ??
      asString(explicitRunHandles?.sessionFile) ??
      previous?.runHandles?.sessionFile;
    const transcript =
      asString(source.transcript) ??
      asString(explicitRunHandles?.transcript) ??
      previous?.runHandles?.transcript;
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
      asString(source.jobId) ?? asString(explicitRunHandles?.jobId) ?? previous?.runHandles?.jobId;
    const scriptPath =
      asString(source.scriptPath) ??
      asString(explicitRunHandles?.scriptPath) ??
      previous?.runHandles?.scriptPath;
    const transcriptDir =
      asString(source.transcriptDir) ??
      asString(explicitRunHandles?.transcriptDir) ??
      previous?.runHandles?.transcriptDir;
    const sessionUrl =
      asString(source.sessionUrl) ??
      asString(explicitRunHandles?.sessionUrl) ??
      previous?.runHandles?.sessionUrl;
    const runHandles =
      explicitRunHandles === undefined &&
      runId === undefined &&
      sessionFile === undefined &&
      transcript === undefined &&
      outputPath === undefined &&
      patchPath === undefined &&
      worktreePath === undefined &&
      branch === undefined &&
      jobId === undefined &&
      scriptPath === undefined &&
      transcriptDir === undefined &&
      sessionUrl === undefined
        ? previous?.runHandles
        : {
            ...(runId === undefined ? {} : { runId }),
            ...(sessionFile === undefined ? {} : { sessionFile }),
            ...(transcript === undefined ? {} : { transcript }),
            ...(outputPath === undefined ? {} : { outputPath }),
            ...(patchPath === undefined ? {} : { patchPath }),
            ...(worktreePath === undefined ? {} : { worktreePath }),
            ...(branch === undefined ? {} : { branch }),
            ...(jobId === undefined ? {} : { jobId }),
            ...(scriptPath === undefined ? {} : { scriptPath }),
            ...(transcriptDir === undefined ? {} : { transcriptDir }),
            ...(sessionUrl === undefined ? {} : { sessionUrl }),
          };
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

    const oldParent = this.updateHierarchy(id, parentTaskId, taskToolCallId);
    this.taskState.set(id, snapshot);
    if (holdingParentSettlement) this.pendingSettlement.set(id, nativeStatus);
    else this.pendingSettlement.delete(id);

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
    if (oldParent !== undefined && oldParent !== parentTaskId)
      this.appendSettledParents(projected, id, event, oldParent);
    if (!holdingParentSettlement && TERMINAL_STATUSES.has(status))
      this.appendSettledParents(projected, id, event);
    this.trimTaskState();
    return projected;
  }

  private updateHierarchy(
    id: string,
    parentTaskId: string | undefined,
    taskToolCallId: string | undefined,
  ): string | undefined {
    const oldParent = this.taskState.get(id)?.parentTaskId;
    if (oldParent !== undefined && oldParent !== parentTaskId) {
      const children = this.childrenByParent.get(oldParent);
      children?.delete(id);
      if (children?.size === 0) this.childrenByParent.delete(oldParent);
    }
    if (parentTaskId !== undefined) {
      const children = this.childrenByParent.get(parentTaskId) ?? new Set<string>();
      children.add(id);
      this.childrenByParent.set(parentTaskId, children);
    }

    if (taskToolCallId !== undefined) {
      for (const [toolCallId, taskId] of this.taskByToolCall) {
        if (taskId === id && toolCallId !== taskToolCallId) this.taskByToolCall.delete(toolCallId);
      }
      this.taskByToolCall.set(taskToolCallId, id);
    }
    return oldParent;
  }

  private appendSettledParents(
    projected: PiFamilyProjectedEvent[],
    childId: string,
    raw: RpcEnvelope,
    startingParentId?: string,
  ): void {
    const visited = new Set<string>();
    let parentId = startingParentId ?? this.taskState.get(childId)?.parentTaskId;
    while (parentId !== undefined) {
      if (visited.has(parentId)) {
        this.host.retainUnknown(raw, "cyclic task parent hierarchy");
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
      parentId = parent.parentTaskId;
    }
  }
  /**
   * Evict only terminal snapshots. Active snapshots may temporarily exceed the
   * configured cap so eviction cannot make live child work appear terminal.
   */
  private trimTaskState(): void {
    while (this.taskState.size > this.maxTaskSnapshots) {
      const candidate = [...this.taskState.entries()].find(([, task]) =>
        TERMINAL_STATUSES.has(task.status),
      );
      if (candidate === undefined) break;
      const [id, task] = candidate;
      this.taskState.delete(id);
      this.pendingSettlement.delete(id);
      const parentId = task.parentTaskId;
      if (parentId !== undefined) {
        const children = this.childrenByParent.get(parentId);
        children?.delete(id);
        if (children?.size === 0) this.childrenByParent.delete(parentId);
      }
      this.childrenByParent.delete(id);
      for (const [toolCallId, taskId] of this.taskByToolCall) {
        if (taskId === id) this.taskByToolCall.delete(toolCallId);
      }
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
}
