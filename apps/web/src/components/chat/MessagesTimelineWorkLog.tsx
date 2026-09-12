import { EventId, type ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { parseActivityDetail } from "@t3tools/client-runtime/activity-details";
import { orchestrationEnvironment } from "../../state/orchestration";
import { commandProgramName } from "@t3tools/client-runtime/work-log/command-label";
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import {
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
} from "../../session-logic";
import {
  formatAgentSpawnOutcome,
  workEntryIsVisibleInGroup,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { useTimelineRowActivityState, useTimelineRowSharedState } from "./MessagesTimelineContext";
import {
  normalizeCompactToolLabel,
  toolGroupAction,
} from "@t3tools/client-runtime/work-log/presentation";
import { cn } from "~/lib/utils";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

type TimelineWorkLogRowData = Extract<
  MessagesTimelineRow,
  { kind: "work" | "work-live" | "work-toggle" | "working" | "thinking" }
>;

export const TimelineWorkLogRow = memo(function TimelineWorkLogRow({
  row,
}: {
  row: TimelineWorkLogRowData;
}) {
  if (row.kind === "work") {
    return (
      <WorkGroupSection
        groupedEntries={row.groupedEntries}
        isExpandedToolGroupEntry={row.isExpandedToolGroupEntry}
      />
    );
  }
  if (row.kind === "work-live") {
    return <LiveWorkEntryTimelineRow row={row} />;
  }
  if (row.kind === "work-toggle") {
    return <WorkGroupToggleTimelineRow row={row} />;
  }
  if (row.kind === "working") {
    return <WorkingTimelineRow row={row} />;
  }
  return <ThinkingTimelineRow />;
});
function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isPreparingWorktree } = useTimelineRowActivityState();
  return (
    <div className="border-b border-border/60 pb-2 pt-1" data-t3-part="timeline-status">
      <div className="flex h-6 min-w-0 items-baseline px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          key={isPreparingWorktree ? "setup" : "working"}
          className="relative shrink-0 overflow-hidden whitespace-nowrap transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none"
        >
          {isPreparingWorktree ? (
            <>
              Setting up worktree…
              <ActivityShimmerOverlay>Setting up worktree…</ActivityShimmerOverlay>
            </>
          ) : row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

function ThinkingTimelineRow() {
  const { isPreparingWorktree } = useTimelineRowActivityState();
  // Reserve the activity row during setup so the handoff keeps the same height.
  return (
    <div className="flex min-h-7 items-center gap-1.5" data-t3-part="timeline-status">
      {isPreparingWorktree ? null : (
        <>
          <img
            src="/mascot/kyle-mascot-64.png"
            alt="Thinking Mascot"
            className="h-4 w-4 shrink-0 rounded-full object-cover shadow-xs motion-safe:animate-pulse"
            draggable={false}
          />
          <LiveActivityRow label="Thinking" />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  isExpandedToolGroupEntry,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroupEntry: boolean;
}) {
  const { workspaceRoot } = useTimelineRowSharedState();
  const nonEmptyEntries = useMemo(
    () =>
      groupedEntries.filter((entry) => workEntryIsVisibleInGroup(entry, isExpandedToolGroupEntry)),
    [groupedEntries, isExpandedToolGroupEntry],
  );
  const GroupContainer = isExpandedToolGroupEntry ? "div" : "section";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <GroupContainer
      className={cn("-mx-1 px-1", isExpandedToolGroupEntry ? "py-0" : "space-y-0.5 py-0.5")}
      aria-label={isExpandedToolGroupEntry ? undefined : "Activity"}
      data-t3-part="timeline-tool-call"
    >
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
            isExpandedToolGroupEntry={isExpandedToolGroupEntry}
          />
        ))}
      </div>
    </GroupContainer>
  );
});

function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

function LiveActivityRow({
  label,
  iconName,
  failed = false,
}: {
  label: string;
  iconName?: WorkEntryIconName;
  failed?: boolean;
}) {
  return (
    <div className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
      <LiveActivityContent
        label={label}
        iconName={iconName}
        failed={failed}
        announceFailure={failed}
      />
      <ActivityShimmerOverlay>
        <LiveActivityContent label={label} iconName={iconName} failed={failed} highlighted />
      </ActivityShimmerOverlay>
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  failed = false,
  announceFailure = false,
  highlighted = false,
}: {
  label: string;
  iconName: WorkEntryIconName | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  highlighted?: boolean;
}) {
  const resolvedIconName = failed ? "circle-alert" : iconName;

  return (
    <span
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-1.5 py-0.5",
        resolvedIconName ? "px-0.5" : "px-1",
        highlighted ? "text-foreground" : "text-secondary-label",
      )}
    >
      {resolvedIconName ? (
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            highlighted ? "text-foreground" : "text-icon-muted",
          )}
          role={announceFailure ? "img" : undefined}
          aria-label={announceFailure ? "Tool call failed" : undefined}
        >
          <WorkEntryIconSvg
            name={resolvedIconName}
            className={cn("block size-4 shrink-0 stroke-[1.8]", !highlighted && "opacity-70")}
          />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </span>
  );
}

function LiveWorkEntryTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-live" }> }) {
  const ctx = useTimelineRowSharedState();
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);

  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      data-t3-part="timeline-tool-call"
      aria-label={failed ? `${label}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      {row.active ? (
        <LiveActivityRow label={label} iconName={workEntryIconName(row.entry)} failed={failed} />
      ) : (
        <div className="min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
          <LiveActivityContent
            label={label}
            iconName={workEntryIconName(row.entry)}
            failed={failed}
            announceFailure={failed}
          />
        </div>
      )}
    </button>
  );
}

function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = useTimelineRowSharedState();
  return (
    <button
      type="button"
      className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      data-t3-part="timeline-tool-call"
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <WorkEntryIconSvg
          name={toolGroupSummaryIconName(row.summaryKind)}
          className="size-4 shrink-0 stroke-[1.8] opacity-70"
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary-label">{row.summary}</span>
    </button>
  );
}
function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-icon-muted",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground",
  };
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function liveWorkEntryLabel(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  active: boolean,
): string {
  const command = workEntry.command?.trim();
  if (command) {
    const program = commandProgramName(command);
    const verb = active
      ? "Running"
      : workEntry.toolLifecycleStatus === "declined"
        ? "Declined"
        : "Ran";
    if (program) return `${verb} ${program}`;
    return `${verb} command`;
  }

  return workEntryPreview(workEntry, workspaceRoot) ?? toolWorkEntryHeading(workEntry);
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.toolData !== undefined) {
    if (workEntry.itemType === "mcp_tool_call") {
      blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
    } else if (
      workEntry.itemType === "dynamic_tool_call" ||
      workEntry.itemType === "collab_agent_tool_call"
    ) {
      blocks.push(`Tool call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
    }
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text";

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A1 spawn CTA: one anchored row per workflow run (or per-turn direct-spawn
 * batch). Live status is derived from the shared agent panel model at render
 * time — the row itself never re-renders a roster; the Agents panel is the
 * only roster. Freezes to past tense when every member settles. Static dot,
 * no animation.
 */
const AgentSpawnCtaRow = memo(function AgentSpawnCtaRow(props: { workEntry: TimelineWorkEntry }) {
  const { workEntry } = props;
  const { agentPanelModel, onOpenAgents } = useTimelineRowSharedState();
  const spawn = workEntry.agentSpawn;
  if (!spawn) {
    return null;
  }

  const memberIds = new Set(spawn.agentTaskIds);
  const workflowGroup = spawn.workflowId
    ? agentPanelModel.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  const agents = workflowGroup
    ? [...workflowGroup.phases.flatMap((phase) => phase.members), ...workflowGroup.unphasedMembers]
    : agentPanelModel.directAgents.filter((agent) => memberIds.has(agent.id));
  const agentCount = Math.max(
    agents.length,
    Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
  );

  const running = agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  const waiting = agents.filter((agent) => agent.status === "waiting").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted",
  ).length;
  // The coordinator's own status is authoritative for workflows: dynamic
  // spawns mean the member list can be momentarily all-settled while the
  // run is still mid-flight (the "completed" lie from live testing). A
  // workflow is live until the coordinator itself reaches a terminal state.
  const coordinatorStatus = workflowGroup?.workflow.status;
  const coordinatorSettled =
    coordinatorStatus === "completed" ||
    coordinatorStatus === "failed" ||
    coordinatorStatus === "cancelled" ||
    coordinatorStatus === "interrupted";
  const live = workflowGroup !== undefined ? !coordinatorSettled : running + waiting > 0;
  // Same rule as the panel footer: providers may aggregate member usage into
  // the coordinator, so count the coordinator only when no members exist.
  const totalTokens = agents.reduce(
    (sum, agent) => sum + (agent.usage?.totalTokens ?? 0),
    spawn.workflowId && agents.length === 0 ? (workflowGroup?.workflow.usage?.totalTokens ?? 0) : 0,
  );

  const livePhase = workflowGroup?.phases.find((phase) => phase.state === "running");
  const workflowName =
    workflowGroup?.workflow.workflowName ?? workflowGroup?.workflow.title ?? null;

  const working = running + waiting;
  const dotClass = live
    ? "bg-info"
    : failed > 0
      ? "bg-destructive"
      : stopped > 0
        ? "bg-muted-foreground/60"
        : "bg-success";
  const lead = live
    ? `Kicked off ${agentCount} subagent${agentCount === 1 ? "" : "s"}`
    : `Ran ${agentCount} subagent${agentCount === 1 ? "" : "s"}`;
  const status = live
    ? livePhase
      ? `${livePhase.title} · ${livePhase.activeCount} working`
      : working > 0
        ? `${working} working`
        : "working"
    : formatAgentSpawnOutcome(failed, stopped);

  return (
    <button
      type="button"
      onClick={onOpenAgents}
      className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      <WorkEntryIconSvg name="bot" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="font-medium">{lead}</span>
        {workflowName ? <span className="text-muted-foreground"> · {workflowName}</span> : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
        <span>{status}</span>
        {totalTokens > 0 ? (
          <span className="tabular-nums">Σ {formatSubagentTokenCount(totalTokens)}</span>
        ) : null}
        <span className="text-info-foreground">{live ? "Open Agents ▸" : "View ▸"}</span>
      </span>
    </button>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry } = props;
  // Before any hooks: spawn CTA rows render their own component.
  if (workEntry.agentSpawn) {
    return <AgentSpawnCtaRow workEntry={workEntry} />;
  }
  return (
    <PlainWorkEntryRow
      workEntry={workEntry}
      workspaceRoot={workspaceRoot}
      isExpandedToolGroupEntry={isExpandedToolGroupEntry}
    />
  );
});

function ToolActivityDetail(props: { threadRef: ScopedThreadRef; activityId: string }) {
  const ctx = useTimelineRowSharedState();
  const result = useAtomValue(
    orchestrationEnvironment.activityDetail({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, activityId: EventId.make(props.activityId) },
    }),
  );
  const detail = useMemo(
    () => (result._tag === "Success" ? parseActivityDetail(result.value) : null),
    [result],
  );
  if (result._tag === "Failure") {
    return (
      <p role="alert" className="text-xs text-destructive-foreground">
        Could not load full tool details.
      </p>
    );
  }
  if (result._tag !== "Success" || detail === null) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading tool details…
      </p>
    );
  }
  return (
    <div className="max-h-[36rem] space-y-3 overflow-auto" data-t3-part="tool-output">
      {result.value.kind === "tool.updated" ? (
        <p className="text-xs text-muted-foreground">
          Live preview. Complete output appears when the tool finishes.
        </p>
      ) : null}
      {detail.sections.map((section, sectionIndex) => (
        <section key={sectionIndex} className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">{section.title}</h4>
          {section.blocks.map((block, blockIndex) =>
            block.kind === "image" ? (
              <button
                key={blockIndex}
                type="button"
                className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Expand ${block.alt}`}
                onClick={() =>
                  ctx.onImageExpand({ images: [{ src: block.source, name: block.alt }], index: 0 })
                }
              >
                <img
                  src={block.source}
                  alt={block.alt}
                  className="max-h-64 max-w-full rounded-md object-contain"
                />
              </button>
            ) : (
              <pre key={blockIndex} className={toolCallExpandedBodyClassName}>
                {block.kind === "text" ? block.text : JSON.stringify(block.value, null, 2)}
              </pre>
            ),
          )}
        </section>
      ))}
    </div>
  );
}

const PlainWorkEntryRow = memo(function PlainWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  isExpandedToolGroupEntry: boolean;
}) {
  const { workEntry, workspaceRoot, isExpandedToolGroupEntry } = props;
  const { onOpenNativeTerminal, threadRef } = useTimelineRowSharedState();
  const [expanded, setExpanded] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator = workEntryDisplayIndicatesToolFailure(workEntry);
  const entryIconName =
    showWarningIndicator || showFailedIndicator ? "circle-alert" : workEntryIconName(workEntry);
  const displayText = workEntryPreview(workEntry, workspaceRoot) ?? toolWorkEntryHeading(workEntry);
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot);
  const terminalFallback = workEntry.nativeTerminalFallback;
  const hasFullDetail = threadRef !== null && workLogEntryIsToolLike(workEntry);
  const canExpand = (expandedBody !== null || hasFullDetail) && terminalFallback === undefined;
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  // Ordinary tool failures stay muted; only runtime errors and warnings get
  // color. The red treatment is reserved for severe failures.
  const iconWrapperClass = cn(
    "flex size-6 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-icon-muted"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const showEntryIcon = !isExpandedToolGroupEntry || showWarningIndicator || showFailedIndicator;
  const accessibleDisplayText = showFailedIndicator
    ? `${displayText}, tool call failed`
    : displayText;
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 transition-colors",
        isExpandedToolGroupEntry ? "py-0" : "py-0.5",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span
          className={cn(iconWrapperClass, !showEntryIcon && "invisible")}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
          aria-hidden={!showEntryIcon}
        >
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-4 shrink-0 stroke-[1.8] opacity-70"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div
            className={cn(
              "flex min-w-0 flex-1 gap-2 overflow-hidden",
              terminalFallback
                ? "flex-col items-start sm:flex-row sm:items-center"
                : "items-center",
            )}
          >
            <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
              <span
                className={cn(
                  "min-w-0 flex-1",
                  terminalFallback ? "break-words whitespace-normal" : "truncate",
                  headingClass,
                )}
              >
                {displayText}
              </span>
            </p>
            {terminalFallback ? (
              <button
                type="button"
                className="max-w-full shrink-0 whitespace-normal rounded-md border border-border/70 px-2 py-1 text-left text-xs font-medium text-foreground transition hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                aria-label={`Open ${terminalFallback.runtime.toUpperCase()} client in terminal for provider ${terminalFallback.providerInstanceId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenNativeTerminal(terminalFallback);
                }}
              >
                Open {terminalFallback.runtime.toUpperCase()} client in terminal
              </button>
            ) : null}
          </div>
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              terminalFallback ? "hidden" : !canExpand && "invisible",
            )}
            aria-hidden
          >
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </span>
        </div>
      </div>
      {expanded && canExpand ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          {hasFullDetail && threadRef ? (
            <ToolActivityDetail threadRef={threadRef} activityId={workEntry.id} />
          ) : (
            <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
});
