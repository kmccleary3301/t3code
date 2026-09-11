import type {
  ChatFileAttachment,
  EnvironmentId,
  MessageId,
  ScopedThreadRef,
  ServerProviderSkill,
  TurnId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import type { AgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import type { WorkLogEntry } from "../../session-logic";
import { createContext, use } from "react";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.

export interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
  openingVideoAttachmentId: string | null;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  agentPanelModel: AgentPanelModel;
  onOpenAgents: () => void;
  onOpenNativeTerminal: (fallback: NonNullable<WorkLogEntry["nativeTerminalFallback"]>) => void;
}

export interface TimelineRowActivityState {
  isWorking: boolean;
  isPreparingWorktree: boolean;
  isRevertingCheckpoint: boolean;
  latestTurnId: TurnId | null;
}

export const TimelineRowCtx = createContext<TimelineRowSharedState | null>(null);
export const TimelineRowActivityCtx = createContext<TimelineRowActivityState | null>(null);

export function useTimelineRowSharedState(): TimelineRowSharedState {
  const value = use(TimelineRowCtx);
  if (value === null) throw new Error("Timeline rows require their shared state provider.");
  return value;
}

export function useTimelineRowActivityState(): TimelineRowActivityState {
  const value = use(TimelineRowActivityCtx);
  if (value === null) throw new Error("Timeline rows require their activity state provider.");
  return value;
}
