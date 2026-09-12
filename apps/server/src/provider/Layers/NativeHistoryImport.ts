import {
  classifyTaskAgentKind,
  EventId,
  MessageId,
  type TaskProgressPayload,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";

import type {
  ProviderNativeHistoryMessage,
  ProviderNativeHistoryTextMessage,
  ProviderNativeHistoryToolMessage,
} from "../Services/ProviderAdapter.ts";

export type ImportedNativeTurn = OrchestrationLatestTurn & {
  readonly assistantMessageId: MessageId | null;
};

function activityKind(phase: "started" | "updated" | "completed"): string {
  return `tool.${phase}`;
}

function activitySummary(phase: "started" | "updated" | "completed", title: string): string {
  return phase === "started"
    ? `${title} started`
    : phase === "updated"
      ? `${title} updated`
      : title;
}

function toolCallId(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  if ("toolCallId" in payload && typeof payload.toolCallId === "string") return payload.toolCallId;
  if (
    "data" in payload &&
    typeof payload.data === "object" &&
    payload.data !== null &&
    "toolCallId" in payload.data &&
    typeof payload.data.toolCallId === "string"
  ) {
    return payload.data.toolCallId;
  }
  return undefined;
}

function activityTaskId(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  if ("taskId" in payload && typeof payload.taskId === "string") return payload.taskId;
  if (
    "data" in payload &&
    typeof payload.data === "object" &&
    payload.data !== null &&
    "taskId" in payload.data &&
    typeof payload.data.taskId === "string"
  ) {
    return payload.data.taskId;
  }
  return undefined;
}

function activityToolUseId(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  if ("toolUseId" in payload && typeof payload.toolUseId === "string") return payload.toolUseId;
  return undefined;
}

function taskActivityPhase(status: TaskProgressPayload["status"]): "progress" | "completed" {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
    ? "completed"
    : "progress";
}

function preserveCapturedToolResult(
  incoming: ProviderNativeHistoryToolMessage["payload"],
  previous: OrchestrationThreadActivity["payload"] | undefined,
): ProviderNativeHistoryToolMessage["payload"] {
  const data = incoming.data;
  if (typeof data !== "object" || data === null || !("item" in data)) return incoming;
  const item = data.item;
  if (typeof item !== "object" || item === null || !("result" in item)) return incoming;
  const result = item.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("prunedAt" in result) ||
    typeof result.prunedAt !== "number"
  )
    return incoming;
  if (typeof previous !== "object" || previous === null || !("data" in previous)) return incoming;
  const previousData = previous.data;
  if (typeof previousData !== "object" || previousData === null || !("item" in previousData))
    return incoming;
  const previousItem = previousData.item;
  if (typeof previousItem !== "object" || previousItem === null || !("result" in previousItem))
    return incoming;

  // Native context pruning must not erase output T3 already captured.
  return {
    ...incoming,
    ...("rawOutput" in previous && typeof previous.rawOutput === "string"
      ? { rawOutput: previous.rawOutput }
      : {}),
    data: {
      ...data,
      item: { ...item, result: previousItem.result },
    },
  };
}

/** Reuse proven live/imported identities without treating repeated text as identity. */
export class NativeHistoryIdentities {
  private readonly messagesById = new Map<MessageId, OrchestrationMessage>();
  private readonly messagesByRoleAndText = new Map<string, Map<string, OrchestrationMessage[]>>();
  private readonly legacyMessagesByTime = new Map<string, OrchestrationMessage[]>();
  private readonly activitiesById = new Map<EventId, OrchestrationThreadActivity>();
  private readonly activitiesByCall = new Map<string, OrchestrationThreadActivity[]>();
  private readonly activitiesByTask = new Map<string, OrchestrationThreadActivity[]>();
  private readonly turnsById = new Map<TurnId, ImportedNativeTurn>();
  private readonly usedMessages = new Set<MessageId>();
  private readonly usedActivities = new Set<EventId>();
  private readonly nativeMessagePrefix: string;

  constructor(input: {
    threadId: ThreadId;
    messages: ReadonlyArray<OrchestrationMessage>;
    activities: ReadonlyArray<OrchestrationThreadActivity>;
    turns: ReadonlyArray<ImportedNativeTurn>;
  }) {
    this.nativeMessagePrefix = `native-message:${input.threadId}:`;
    for (const turn of input.turns) this.turnsById.set(turn.turnId, turn);
    for (const message of input.messages) {
      this.messagesById.set(message.id, message);
      const byText =
        this.messagesByRoleAndText.get(message.role) ?? new Map<string, OrchestrationMessage[]>();
      const candidates = byText.get(message.text) ?? [];
      candidates.push(message);
      byText.set(message.text, candidates);
      this.messagesByRoleAndText.set(message.role, byText);
      if (
        message.id.startsWith(this.nativeMessagePrefix) &&
        /^\d+$/.test(message.id.slice(this.nativeMessagePrefix.length))
      ) {
        const key = `${message.role}:${message.createdAt}`;
        const legacy = this.legacyMessagesByTime.get(key) ?? [];
        legacy.push(message);
        this.legacyMessagesByTime.set(key, legacy);
      }
    }
    for (const activity of input.activities) {
      this.activitiesById.set(activity.id, activity);
      const callId = toolCallId(activity);
      if (callId !== undefined) {
        const candidates = this.activitiesByCall.get(callId) ?? [];
        candidates.push(activity);
        this.activitiesByCall.set(callId, candidates);
      }
      const taskId = activityTaskId(activity);
      if (taskId !== undefined) {
        const candidates = this.activitiesByTask.get(taskId) ?? [];
        candidates.push(activity);
        this.activitiesByTask.set(taskId, candidates);
      }
    }
  }

  getTurn(id: TurnId | null | undefined): ImportedNativeTurn | undefined {
    return id == null ? undefined : this.turnsById.get(id);
  }
  hasActivity(id: EventId): boolean {
    return this.activitiesById.has(id);
  }

  hasMessage(id: MessageId): boolean {
    return this.messagesById.has(id);
  }

  private turnForTimestamp(timestamp: string): ImportedNativeTurn | undefined {
    let match: ImportedNativeTurn | undefined;
    for (const turn of this.turnsById.values()) {
      if (!this.withinTurn(timestamp, turn.turnId)) continue;
      if (match !== undefined) return undefined;
      match = turn;
    }
    return match;
  }

  /** User messages are projected before turn start, so their turnId is null. */
  turnForMessage(
    message: OrchestrationMessage,
    timestamp = message.createdAt,
  ): ImportedNativeTurn | undefined {
    return this.getTurn(message.turnId) ?? this.turnForTimestamp(timestamp);
  }

  matchMessage(
    native: ProviderNativeHistoryTextMessage,
    generatedId: MessageId,
    turnId: TurnId | null,
  ): OrchestrationMessage | undefined {
    const exact = this.messagesById.get(generatedId);
    const legacyCandidates = this.legacyMessagesByTime
      .get(`${native.role}:${native.timestamp}`)
      ?.filter((message) => !this.usedMessages.has(message.id));
    const legacy =
      legacyCandidates?.find((message) => message.text === native.text) ??
      (legacyCandidates?.length === 1 ? legacyCandidates[0] : undefined);
    const nativeTurn = this.turnForTimestamp(native.timestamp);
    const candidate =
      exact ??
      legacy ??
      this.messagesByRoleAndText
        .get(native.role)
        ?.get(native.text)
        ?.find(
          (message) =>
            !this.usedMessages.has(message.id) &&
            !message.id.startsWith(this.nativeMessagePrefix) &&
            ((turnId !== null && message.turnId === turnId) ||
              this.withinTurn(native.timestamp, message.turnId) ||
              (nativeTurn !== undefined &&
                this.turnForMessage(message)?.turnId === nativeTurn.turnId)),
        );
    if (candidate === undefined || this.usedMessages.has(candidate.id)) return undefined;
    this.usedMessages.add(candidate.id);
    return candidate;
  }

  private withinTurn(timestamp: string, turnId: TurnId | null): boolean {
    const turn = this.getTurn(turnId);
    return (
      turn !== undefined &&
      turn.completedAt !== null &&
      timestamp >= turn.requestedAt &&
      timestamp <= turn.completedAt
    );
  }

  turnForTool(native: ProviderNativeHistoryToolMessage): ImportedNativeTurn | undefined {
    if (native.toolCallId === undefined) return undefined;
    let matched: ImportedNativeTurn | undefined;
    for (const activity of this.activitiesByCall.get(native.toolCallId) ?? []) {
      if (!this.withinTurn(native.timestamp, activity.turnId)) continue;
      const turn = this.getTurn(activity.turnId);
      if (matched !== undefined && matched.turnId !== turn?.turnId) return undefined;
      matched = turn;
    }
    return matched;
  }

  matchActivity(
    native: ProviderNativeHistoryToolMessage,
    generatedId: EventId,
    turnId: TurnId,
  ): OrchestrationThreadActivity | undefined {
    const exact = this.activitiesById.get(generatedId);
    const candidate =
      exact ??
      (native.toolCallId === undefined || native.phase === "updated"
        ? undefined
        : this.activitiesByCall
            .get(native.toolCallId)
            ?.find(
              (activity) =>
                activity.turnId === turnId &&
                activity.kind === `tool.${native.phase}` &&
                !this.usedActivities.has(activity.id),
            ));
    if (candidate === undefined || this.usedActivities.has(candidate.id)) return undefined;
    this.usedActivities.add(candidate.id);
    return candidate;
  }
  resolveTaskActivities(
    native: TaskProgressPayload,
    generatedId: EventId,
    turnId: TurnId,
    phase: "progress" | "completed",
  ): {
    readonly matches: ReadonlyArray<OrchestrationThreadActivity>;
    readonly latestCreatedAt: string | undefined;
  } {
    const exact = this.activitiesById.get(generatedId);
    const matches: OrchestrationThreadActivity[] = [];
    let latestCreatedAt = exact?.createdAt;
    if (exact !== undefined && !this.usedActivities.has(exact.id)) matches.push(exact);
    for (const activity of this.activitiesByTask.get(native.taskId) ?? []) {
      if (
        activity.turnId !== turnId ||
        (native.toolUseId !== undefined && activityToolUseId(activity) !== native.toolUseId)
      )
        continue;
      if (latestCreatedAt === undefined || activity.createdAt > latestCreatedAt) {
        latestCreatedAt = activity.createdAt;
      }
      if (
        activity.id !== exact?.id &&
        activity.kind === `task.${phase}` &&
        !this.usedActivities.has(activity.id) &&
        (phase === "completed" || matches.length === 0)
      )
        matches.push(activity);
    }
    for (const activity of matches) this.usedActivities.add(activity.id);
    return { matches, latestCreatedAt };
  }
}

export function appendNativeHistoryPage(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ProviderNativeHistoryMessage>;
  readonly messageOffset: number;
  readonly turnOffset: number;
  readonly currentTurn: ImportedNativeTurn | null;
  readonly identities?: NativeHistoryIdentities;
}): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turns: ReadonlyArray<OrchestrationLatestTurn>;
  readonly messageOffset: number;
  readonly turnOffset: number;
  readonly currentTurn: ImportedNativeTurn | null;
} {
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const turns: OrchestrationLatestTurn[] = [];
  let messageOffset = input.messageOffset;
  let turnOffset = input.turnOffset;
  let currentTurn = input.currentTurn;
  let currentTurnDirty = false;

  const flushCurrentTurn = () => {
    if (
      currentTurn !== null &&
      currentTurnDirty &&
      input.identities?.getTurn(currentTurn.turnId) === undefined
    ) {
      turns.push(currentTurn);
    }
    currentTurnDirty = false;
  };

  for (const nativeMessage of input.messages) {
    messageOffset += 1;
    const sourceKey =
      nativeMessage.sourceId === undefined
        ? String(messageOffset)
        : `${nativeMessage.sourceId}:${nativeMessage.sourceIndex ?? 0}`;
    const generatedMessageId = MessageId.make(`native-message:${input.threadId}:${sourceKey}`);
    const existingMessage =
      nativeMessage.role === "tool"
        ? undefined
        : input.identities?.matchMessage(
            nativeMessage,
            generatedMessageId,
            currentTurn?.turnId ?? null,
          );
    const messageId = existingMessage?.id ?? generatedMessageId;

    if (nativeMessage.role === "system") {
      messages.push({
        id: messageId,
        role: "system",
        text: nativeMessage.text,
        ...(nativeMessage.attachments === undefined
          ? {}
          : { attachments: [...nativeMessage.attachments] }),
        turnId: null,
        streaming: false,
        createdAt: nativeMessage.timestamp,
        updatedAt: nativeMessage.timestamp,
      });
      continue;
    }

    if (nativeMessage.role === "tool") {
      if (currentTurn === null) currentTurn = input.identities?.turnForTool(nativeMessage) ?? null;
      if (currentTurn === null) {
        turnOffset += 1;
        currentTurn = {
          turnId: TurnId.make(
            `native-turn:${input.threadId}:${nativeMessage.sourceId ?? turnOffset}`,
          ),
          state: "interrupted",
          requestedAt: nativeMessage.timestamp,
          startedAt: nativeMessage.timestamp,
          completedAt: null,
          assistantMessageId: null,
        };
      }
      const title = nativeMessage.payload.title ?? "Native Tool";
      const activityId = [
        "native-tool",
        input.threadId,
        nativeMessage.sourceId ?? `offset-${messageOffset}`,
        nativeMessage.sourceIndex ?? 0,
        nativeMessage.phase,
      ].join(":");
      const generatedActivityId = EventId.make(activityId);
      const existingActivity = input.identities?.matchActivity(
        nativeMessage,
        generatedActivityId,
        currentTurn.turnId,
      );
      const activity: OrchestrationThreadActivity = {
        id: existingActivity?.id ?? generatedActivityId,
        tone: "tool",
        kind: activityKind(nativeMessage.phase),
        summary: activitySummary(nativeMessage.phase, title),
        payload: {
          ...preserveCapturedToolResult(nativeMessage.payload, existingActivity?.payload),
          ...(nativeMessage.toolCallId === undefined
            ? {}
            : { toolCallId: nativeMessage.toolCallId }),
        },
        turnId: currentTurn.turnId,
        sequence: messageOffset,
        createdAt: nativeMessage.timestamp,
      };
      activities.push(activity);
      for (const [taskIndex, task] of (nativeMessage.tasks ?? []).entries()) {
        const phase = taskActivityPhase(task.status);
        const taskActivityId = [
          "native-task",
          input.threadId,
          nativeMessage.sourceId ?? `offset-${messageOffset}`,
          nativeMessage.sourceIndex ?? 0,
          nativeMessage.toolCallId ?? "anonymous",
          task.taskId,
          taskIndex,
          phase,
        ].join(":");
        const generatedTaskActivityId = EventId.make(taskActivityId);
        const existing = input.identities?.resolveTaskActivities(
          task,
          generatedTaskActivityId,
          currentTurn.turnId,
          phase,
        );
        const endedAt = phase === "completed" ? task.endedAt : undefined;
        const latestCreatedAt = phase === "completed" ? existing?.latestCreatedAt : undefined;
        const matchCount = Math.max(1, existing?.matches.length ?? 0);
        for (let matchIndex = 0; matchIndex < matchCount; matchIndex++) {
          const matchedActivity = existing?.matches[matchIndex];
          let createdAt = matchedActivity?.createdAt ?? nativeMessage.timestamp;
          if (endedAt !== undefined && endedAt > createdAt) createdAt = endedAt;
          // Terminal snapshots follow all captured progress for this invocation.
          if (latestCreatedAt !== undefined && latestCreatedAt > createdAt)
            createdAt = latestCreatedAt;
          activities.push({
            id: matchedActivity?.id ?? generatedTaskActivityId,
            tone: phase === "completed" && task.status === "failed" ? "error" : "info",
            kind: `task.${phase}`,
            summary: task.summary ?? task.description,
            payload: {
              ...(task.status === "cancelled" || task.status === "interrupted"
                ? { ...task, status: "stopped" }
                : task),
              agentKind: classifyTaskAgentKind({ taskType: task.taskType }),
            },
            turnId: currentTurn.turnId,
            sequence: messageOffset,
            createdAt,
          });
        }
      }
      currentTurn = {
        ...currentTurn,
        state:
          nativeMessage.phase === "completed"
            ? nativeMessage.payload.status === "failed"
              ? "error"
              : "completed"
            : "interrupted",
        completedAt: nativeMessage.phase === "completed" ? nativeMessage.timestamp : null,
      };
      currentTurnDirty = true;
      continue;
    }

    if (nativeMessage.role === "user") {
      flushCurrentTurn();
      turnOffset += 1;
      const existingTurn =
        existingMessage === undefined
          ? undefined
          : input.identities?.turnForMessage(existingMessage, nativeMessage.timestamp);
      currentTurn = existingTurn ?? {
        turnId: TurnId.make(
          `native-turn:${input.threadId}:${nativeMessage.sourceId ?? turnOffset}`,
        ),
        state: "interrupted",
        requestedAt: nativeMessage.timestamp,
        startedAt: nativeMessage.timestamp,
        completedAt: null,
        assistantMessageId: null,
      };
      currentTurnDirty = true;
    } else if (currentTurn === null) {
      turnOffset += 1;
      const existingTurn =
        existingMessage === undefined
          ? undefined
          : input.identities?.turnForMessage(existingMessage, nativeMessage.timestamp);
      currentTurn = existingTurn ?? {
        turnId: TurnId.make(
          `native-turn:${input.threadId}:${nativeMessage.sourceId ?? turnOffset}`,
        ),
        state: "completed",
        requestedAt: nativeMessage.timestamp,
        startedAt: nativeMessage.timestamp,
        completedAt: nativeMessage.timestamp,
        assistantMessageId: messageId,
      };
      currentTurnDirty = true;
    } else {
      currentTurn = {
        ...currentTurn,
        state: "completed",
        startedAt: currentTurn.startedAt ?? nativeMessage.timestamp,
        completedAt: nativeMessage.timestamp,
        assistantMessageId: messageId,
      };
      currentTurnDirty = true;
    }

    messages.push({
      id: messageId,
      role: nativeMessage.role,
      text: nativeMessage.text,
      ...(nativeMessage.attachments === undefined
        ? {}
        : { attachments: [...nativeMessage.attachments] }),
      turnId: currentTurn.turnId,
      streaming: false,
      createdAt: nativeMessage.timestamp,
      updatedAt: nativeMessage.timestamp,
    });
  }
  flushCurrentTurn();
  return {
    messages,
    activities,
    turns,
    messageOffset,
    turnOffset,
    currentTurn,
  };
}
