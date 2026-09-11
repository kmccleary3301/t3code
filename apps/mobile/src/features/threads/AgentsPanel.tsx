import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
  type AgentPanelModel,
  type AgentPanelWorkflowGroup,
  type NativeUiState,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ProviderSubagentTranscriptEntry, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const STATUS_LABELS = {
  pending: "Queued",
  running: "Working",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
} as const satisfies Record<RuntimeSubagent["status"], string>;

const STATUS_ICONS = {
  pending: "clock",
  running: "bolt.circle",
  waiting: "clock",
  idle: "person.crop.circle",
  completed: "checkmark.circle",
  failed: "exclamationmark.triangle",
  cancelled: "xmark.circle.fill",
  interrupted: "stop.fill",
} as const satisfies Record<RuntimeSubagent["status"], string>;

const STATUS_COLORS = {
  pending: "accent-icon-muted",
  running: "accent-icon",
  waiting: "accent-icon-muted",
  idle: "accent-icon-muted",
  completed: "accent-icon",
  failed: "accent-icon",
  cancelled: "accent-icon",
  interrupted: "accent-icon-muted",
} as const satisfies Record<RuntimeSubagent["status"], string>;

function statusDetail(agent: RuntimeSubagent): string {
  if (agent.status === "failed" && agent.error) return agent.error;
  if (agent.status === "completed" && agent.result) return agent.result;
  if (agent.status === "running" && agent.lastToolName) return `Using ${agent.lastToolName}`;
  return agent.progress ?? STATUS_LABELS[agent.status];
}

function elapsedLabel(agent: RuntimeSubagent): string | null {
  if (agent.startedAt === null) return null;
  const end = agent.completedAt ?? agent.updatedAt;
  const elapsed = Math.max(0, Date.parse(end) - Date.parse(agent.startedAt));
  if (!Number.isFinite(elapsed)) return null;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function AgentStatus(props: { readonly agent: RuntimeSubagent }) {
  const color = STATUS_COLORS[props.agent.status];
  return (
    <View className="flex-row items-center gap-1.5">
      <SymbolView
        name={STATUS_ICONS[props.agent.status]}
        size={16}
        tintColorClassName={color}
        type="monochrome"
      />
      <Text className="text-xs font-t3-medium text-foreground-secondary">
        {STATUS_LABELS[props.agent.status]}
      </Text>
    </View>
  );
}

function AgentRow(props: {
  readonly agent: RuntimeSubagent;
  readonly depth?: number;
  readonly onSelect: (agent: RuntimeSubagent) => void;
}) {
  const modelLabel = formatSubagentModelLabel(props.agent.model, props.agent.effort);
  const elapsed = elapsedLabel(props.agent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open transcript for ${props.agent.id}: ${props.agent.title}`}
      className="rounded-2xl border border-border bg-card px-3.5 py-3 active:opacity-70"
      onPress={() => props.onSelect(props.agent)}
      style={props.depth ? { marginLeft: props.depth * 14 } : undefined}
    >
      <View className="flex-row items-start gap-3">
        <View className="mt-0.5">
          <AgentStatus agent={props.agent} />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={3} className="font-t3-bold text-base text-foreground">
            {props.agent.title}
          </Text>
          <Text numberOfLines={2} className="mt-1 text-sm leading-5 text-foreground-muted">
            {statusDetail(props.agent)}
          </Text>
          <View className="mt-2 flex-row flex-wrap items-center gap-x-2 gap-y-1">
            <Text numberOfLines={1} className="font-mono text-xs text-foreground-secondary">
              {props.agent.id}
            </Text>
            {props.agent.role ? (
              <Text numberOfLines={1} className="text-xs text-foreground-secondary">
                {props.agent.role}
              </Text>
            ) : null}
            {modelLabel ? (
              <Text numberOfLines={1} className="font-mono text-xs text-foreground-secondary">
                {modelLabel}
              </Text>
            ) : null}
            {props.agent.usage ? (
              <Text className="font-mono text-xs text-foreground-secondary">
                {formatSubagentTokenCount(props.agent.usage.totalTokens)} tok
              </Text>
            ) : null}
            {elapsed ? (
              <Text className="font-mono text-xs text-foreground-secondary">{elapsed}</Text>
            ) : null}
          </View>
        </View>
        <SymbolView
          name="chevron.right"
          size={18}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

function WorkflowSection(props: {
  readonly group: AgentPanelWorkflowGroup;
  readonly onSelect: (agent: RuntimeSubagent) => void;
}) {
  const initiallyOpen =
    props.group.workflow.status === "running" || props.group.workflow.status === "waiting";
  const [open, setOpen] = useState(initiallyOpen);
  const members = workflowMembers(props.group);
  const activeCount = members.filter(
    (agent) =>
      agent.status === "pending" || agent.status === "running" || agent.status === "waiting",
  ).length;
  return (
    <View className="rounded-3xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} workflow ${props.group.workflow.title}`}
        className="active:opacity-70"
        onPress={() => setOpen((current) => !current)}
      >
        <View className="flex-row items-start gap-3">
          <SymbolView
            name="square.grid.2x2"
            size={20}
            tintColorClassName="accent-primary"
            type="monochrome"
          />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="font-t3-bold text-base text-foreground">
              {props.group.workflow.title}
            </Text>
            <Text className="mt-1 text-sm text-foreground-muted">
              {members.length} {members.length === 1 ? "child" : "children"}
              {activeCount > 0 ? ` · ${activeCount} working` : ""}
            </Text>
          </View>
          <SymbolView
            name={open ? "chevron.up" : "chevron.down"}
            size={18}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </View>
      </Pressable>
      {open ? (
        <View className="mt-3 gap-2">
          {props.group.phases.map((phase) => (
            <View key={phase.index} className="gap-2">
              <View className="flex-row items-center gap-2 px-1">
                <View
                  className={
                    phase.state === "running"
                      ? "size-2 rounded-full bg-primary"
                      : phase.state === "done"
                        ? "size-2 rounded-full bg-subtle-strong"
                        : "size-2 rounded-full bg-subtle"
                  }
                />
                <Text className="text-xs font-t3-bold uppercase tracking-wider text-foreground-secondary">
                  {phase.title}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {phase.settledCount}/{phase.members.length}
                </Text>
              </View>
              {phase.members.map((agent) => (
                <AgentRow key={agent.id} agent={agent} depth={1} onSelect={props.onSelect} />
              ))}
            </View>
          ))}
          {props.group.unphasedMembers.map((agent) => (
            <AgentRow key={agent.id} agent={agent} depth={1} onSelect={props.onSelect} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function NativeUiShelf(props: { readonly state: NativeUiState }) {
  if (props.state.statuses.length === 0 && props.state.widgets.length === 0) return null;
  const widgetsByPlacement = {
    above: props.state.widgets.filter((widget) => widget.placement === "above"),
    below: props.state.widgets.filter((widget) => widget.placement === "below"),
  } as const;
  return (
    <View className="border-b border-border bg-card/50 px-4 py-3">
      <Text className="text-xs font-t3-bold uppercase tracking-wider text-foreground-secondary">
        Native session
      </Text>
      {props.state.statuses.length > 0 ? (
        <View className="mt-2 gap-1.5">
          {props.state.statuses.map((status) => (
            <View key={status.key} className="rounded-xl border border-border bg-screen px-3 py-2">
              <Text className="font-mono text-xs text-foreground">{status.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {(["above", "below"] as const).map((placement) =>
        widgetsByPlacement[placement].length > 0 ? (
          <View key={placement} className="mt-3 gap-2">
            <Text className="text-xs font-t3-medium text-foreground-muted">
              Widgets {placement === "above" ? "above" : "below"} the thread
            </Text>
            {widgetsByPlacement[placement].map((widget) => (
              <View
                key={widget.key}
                className="rounded-2xl border border-border bg-screen px-3 py-2.5"
              >
                <Text className="mb-1 font-mono text-xs text-foreground-secondary">
                  {widget.key}
                </Text>
                <Text selectable className="font-mono text-xs leading-5 text-foreground">
                  {widget.content}
                </Text>
              </View>
            ))}
          </View>
        ) : null,
      )}
    </View>
  );
}

function transcriptLabel(entry: ProviderSubagentTranscriptEntry, agent: RuntimeSubagent): string {
  if (entry.kind === "user") return "Assignment";
  if (entry.kind === "reasoning") return "Reasoning";
  if (entry.kind === "tool") return entry.toolName ?? "Tool";
  if (entry.kind === "system") return "System";
  return agent.role ?? agent.title;
}

function AgentTranscriptBody(props: {
  readonly agent: RuntimeSubagent;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<ReadonlyArray<ProviderSubagentTranscriptEntry>>([]);
  const input = useMemo(
    () =>
      cursor === undefined
        ? { threadId: props.threadId, subagentId: props.agent.id }
        : { threadId: props.threadId, subagentId: props.agent.id, cursor },
    [cursor, props.agent.id, props.threadId],
  );
  const transcript = useEnvironmentQuery(
    serverEnvironment.subagentTranscript({ environmentId: props.environmentId, input }),
  );

  useEffect(() => {
    if (transcript.data === null) return;
    const page = transcript.data;
    setEntries((current) => {
      const base = page.reset ? [] : current;
      const known = new Set(base.map((entry) => entry.id));
      const additions = page.entries.filter((entry) => !known.has(entry.id));
      return additions.length === 0 && !page.reset ? current : [...base, ...additions];
    });
    if (page.nextCursor !== cursor) setCursor(page.nextCursor);
  }, [cursor, transcript.data]);

  if (entries.length === 0 && transcript.isPending) {
    return (
      <View className="items-center px-5 py-10">
        <ActivityIndicator />
        <Text className="mt-3 text-sm text-foreground-muted">Loading transcript…</Text>
      </View>
    );
  }
  if (entries.length === 0 && transcript.error !== null) {
    return (
      <EmptyState
        variant="plain"
        title="Transcript unavailable"
        detail={transcript.error}
        actionLabel="Retry"
        onAction={transcript.refresh}
      />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="No transcript yet"
        detail={
          isTerminalSubagentStatus(props.agent.status)
            ? "This child did not expose transcript entries."
            : "Transcript entries will appear as this child works."
        }
        actionLabel="Refresh"
        onAction={transcript.refresh}
      />
    );
  }
  return (
    <View className="gap-4 px-4 py-4">
      {transcript.error !== null ? (
        <Pressable
          accessibilityRole="button"
          className="rounded-2xl border border-border bg-card px-3 py-2 active:opacity-70"
          onPress={transcript.refresh}
        >
          <Text className="text-sm text-foreground-muted">
            Transcript update failed. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
      {entries.map((entry) => (
        <View key={entry.id} className="min-w-0">
          <View className="mb-1 flex-row items-center gap-2">
            {entry.kind === "tool" ? (
              <SymbolView
                name={{ ios: "hammer", android: "build" }}
                size={14}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            ) : null}
            <Text
              className={`font-mono text-xs uppercase tracking-wider ${entry.isError ? "text-destructive-foreground" : "text-foreground-muted"}`}
            >
              {transcriptLabel(entry, props.agent)}
            </Text>
          </View>
          <Text
            selectable
            className={`text-sm leading-5 ${entry.kind === "reasoning" ? "text-foreground-muted" : "text-foreground"}`}
          >
            {entry.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

function AgentTranscript(props: {
  readonly agent: RuntimeSubagent;
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onBack: () => void;
  readonly onSelect: (agent: RuntimeSubagent) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-screen">
      <View className="border-b border-border bg-card px-4 py-3">
        <View className="flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to agents"
            className="size-10 items-center justify-center rounded-full bg-subtle active:opacity-70"
            onPress={props.onBack}
          >
            <SymbolView
              name="chevron.left"
              size={20}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={3} className="font-t3-bold text-lg text-foreground">
              {props.agent.title}
            </Text>
            <View className="mt-1 flex-row items-center gap-2">
              <AgentStatus agent={props.agent} />
              <Text numberOfLines={1} className="font-mono text-xs text-foreground-secondary">
                {props.agent.id}
              </Text>
              {props.agent.role ? (
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {props.agent.role}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
        {props.agents.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="mt-3"
            contentContainerClassName="gap-2"
          >
            {props.agents.map((agent) => (
              <Pressable
                key={agent.id}
                accessibilityRole="button"
                accessibilityState={{ selected: agent.id === props.agent.id }}
                className={`rounded-full border px-3 py-2 ${agent.id === props.agent.id ? "border-primary bg-primary/15" : "border-border bg-screen"}`}
                onPress={() => props.onSelect(agent)}
              >
                <Text numberOfLines={1} className="max-w-44 text-xs font-t3-medium text-foreground">
                  {agent.id}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <AgentTranscriptBody
          key={`${props.environmentId}:${props.threadId}:${props.agent.id}`}
          agent={props.agent}
          environmentId={props.environmentId}
          threadId={props.threadId}
        />
      </ScrollView>
    </View>
  );
}

export function AgentsPanel(props: {
  readonly model: AgentPanelModel;
  readonly nativeUiState: NativeUiState;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const insets = useSafeAreaInsets();
  const [selectedAgent, setSelectedAgent] = useState<RuntimeSubagent | null>(null);
  useEffect(() => {
    setSelectedAgent(null);
  }, [props.environmentId, props.threadId]);
  const agents = useMemo(() => {
    const all = new Map<string, RuntimeSubagent>();
    for (const group of props.model.workflows) {
      all.set(group.workflow.id, group.workflow);
      for (const agent of workflowMembers(group)) all.set(agent.id, agent);
    }
    for (const agent of props.model.directAgents) all.set(agent.id, agent);
    return [...all.values()];
  }, [props.model]);
  const selected =
    selectedAgent === null ? null : (agents.find((agent) => agent.id === selectedAgent.id) ?? null);

  if (selected !== null) {
    return (
      <AgentTranscript
        agent={selected}
        agents={agents}
        environmentId={props.environmentId}
        threadId={props.threadId}
        onBack={() => setSelectedAgent(null)}
        onSelect={setSelectedAgent}
      />
    );
  }

  const hasNativeUi =
    props.nativeUiState.statuses.length > 0 || props.nativeUiState.widgets.length > 0;
  return (
    <View className="flex-1 bg-screen">
      <ScrollView contentContainerClassName="gap-3 px-4 pb-8 pt-4">
        <NativeUiShelf state={props.nativeUiState} />
        {!props.model.hasAgents ? (
          <EmptyState
            variant="plain"
            title={hasNativeUi ? "No agents yet" : "No agents in this thread"}
            detail={
              hasNativeUi
                ? "Native session status and widgets are shown above. Child agents will appear here when this thread spawns them."
                : "When this thread spawns subagents or runs a workflow, their live status, activity, and token usage will appear here."
            }
          />
        ) : null}
        {props.model.workflows.map((group) => (
          <WorkflowSection key={group.workflow.id} group={group} onSelect={setSelectedAgent} />
        ))}
        {props.model.directAgents.length > 0 ? (
          <View className="gap-2">
            <Text className="px-1 text-xs font-t3-bold uppercase tracking-wider text-foreground-secondary">
              Direct children
            </Text>
            {props.model.directAgents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onSelect={setSelectedAgent} />
            ))}
          </View>
        ) : null}
      </ScrollView>
      {props.model.hasAgents ? (
        <View
          className="border-t border-border bg-card px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="text-sm text-foreground-muted">
              {props.model.liveCount > 0
                ? `${props.model.liveCount} working`
                : "No active children"}
              {props.model.idleCount > 0 ? ` · ${props.model.idleCount} idle` : ""}
              {props.model.settledCount > 0 ? ` · ${props.model.settledCount} settled` : ""}
            </Text>
            <Text className="font-mono text-xs text-foreground-secondary">
              Σ {formatSubagentTokenCount(props.model.totalTokens)} tok
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
