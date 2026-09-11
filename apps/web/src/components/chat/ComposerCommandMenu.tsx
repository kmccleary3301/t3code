import {
  formatProviderSkillDisplayName,
  resolveProviderSkillSourceKind,
  type ProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type ProjectEntry,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  ArrowLeftRightIcon,
  BarChart3Icon,
  BlocksIcon,
  BoxIcon,
  BrainIcon,
  BugIcon,
  CircleHelpIcon,
  CircleUserRoundIcon,
  ClipboardIcon,
  CompassIcon,
  CopyIcon,
  EraserIcon,
  EyeIcon,
  FileOutputIcon,
  FileTextIcon,
  FootprintsIcon,
  FolderIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  ForwardIcon,
  GitBranchIcon,
  GlobeIcon,
  GaugeIcon,
  HammerIcon,
  HistoryIcon,
  InboxIcon,
  KeyboardIcon,
  ListIcon,
  ListTodoIcon,
  LogInIcon,
  LogOutIcon,
  Maximize2Icon,
  MessageSquareIcon,
  MicIcon,
  Minimize2Icon,
  MonitorIcon,
  NetworkIcon,
  NewspaperIcon,
  PackageIcon,
  PanelTopIcon,
  PauseIcon,
  PencilIcon,
  PinIcon,
  PlugIcon,
  PlusIcon,
  PowerIcon,
  PuzzleIcon,
  RadioIcon,
  Redo2Icon,
  Repeat2Icon,
  RocketIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  Share2Icon,
  ShieldIcon,
  ShoppingCartIcon,
  StethoscopeIcon,
  TargetIcon,
  Trash2Icon,
  UserRoundIcon,
  UsersRoundIcon,
  VibrateIcon,
  WavesIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";

import { type ComposerSlashCommand, type ComposerTriggerKind } from "../../composer-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandItem, CommandList } from "../ui/command";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { ComposerBanner } from "./ComposerBanner";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-argument";
      provider: ProviderDriverKind;
      command: ServerProviderSlashCommand;
      insertText: string;
      searchValue: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderDriverKind;
      skill: ServerProviderSkill;
      label: string;
      description: string;
    };

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <ComposerBanner.Surface
        ref={listRef}
        className="w-full overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
        data-composer-command-drawer="true"
        data-t3-surface="autocomplete"
      >
        {props.items.length > 0 ? (
          <CommandList className="max-h-72 scroll-pb-6">
            <CommandGroup>
              {props.items.map((item) => (
                <ComposerCommandMenuItem
                  key={item.id}
                  item={item}
                  triggerKind={props.triggerKind}
                  resolvedTheme={props.resolvedTheme}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          </CommandList>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs">
              {props.isLoading
                ? props.triggerKind === "skill"
                  ? "Searching workspace skills..."
                  : props.triggerKind === "path"
                    ? "Searching workspace files..."
                    : "Loading native commands..."
                : (props.emptyStateText ??
                  (props.triggerKind === "skill"
                    ? "No skills found. Try / to browse provider commands."
                    : props.triggerKind === "path"
                      ? "No matching files or folders."
                      : "No matching command."))}
            </p>
          </div>
        )}
      </ComposerBanner.Surface>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  triggerKind: ComposerTriggerKind | null;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const skillSourceKind =
    props.item.type === "skill" ? resolveProviderSkillSourceKind(props.item.skill) : null;
  const isSlashSkill =
    props.triggerKind === "slash-command" && props.item.type === "skill" ? props.item.skill : null;
  const CommandIcon =
    props.item.type === "provider-slash-command" && props.item.command.icon
      ? (COMMAND_ICON_MAP[props.item.command.icon] ?? CircleHelpIcon)
      : undefined;

  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-3 rounded-lg px-3 py-2! hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <PierreEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {CommandIcon ? (
        <CommandIcon aria-hidden="true" className="size-3.5 shrink-0 text-secondary-label" />
      ) : null}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
          {isSlashSkill ? (
            <>
              <span className="text-secondary-label">/skill:</span>
              {formatProviderSkillDisplayName(isSlashSkill)}
            </>
          ) : (
            props.item.label
          )}
        </span>
        <span className="min-w-0 max-w-[48ch] flex-1 truncate text-left text-secondary-label text-xs">
          {props.item.description}
        </span>
        {skillSourceKind ? (
          <SkillSourceBadge
            kind={skillSourceKind}
            showSkillSuffix={props.triggerKind === "skill"}
          />
        ) : null}
      </span>
    </CommandItem>
  );
});

const SKILL_SOURCE_ICON_BY_KIND: Record<ProviderSkillSourceKind, LucideIcon> = {
  app: BlocksIcon,
  repo: FolderIcon,
  project: FolderIcon,
  personal: UserRoundIcon,
  system: SettingsIcon,
  other: PackageIcon,
};
const COMMAND_ICON_MAP: Record<string, LucideIcon> = {
  advisor: EyeIcon,
  agents: UsersRoundIcon,
  branch: GitBranchIcon,
  broadcast: RadioIcon,
  bug: BugIcon,
  cart: ShoppingCartIcon,
  clipboard: ClipboardIcon,
  compass: CompassIcon,
  compress: Minimize2Icon,
  computer: MonitorIcon,
  context: PanelTopIcon,
  copy: CopyIcon,
  eraser: EraserIcon,
  expand: Maximize2Icon,
  export: FileOutputIcon,
  extension: PuzzleIcon,
  fast: ZapIcon,
  folderMinus: FolderMinusIcon,
  folderMove: FolderInputIcon,
  folderPlus: FolderPlusIcon,
  gauge: GaugeIcon,
  gear: SettingsIcon,
  globe: GlobeIcon,
  goal: TargetIcon,
  hammer: HammerIcon,
  handoff: ForwardIcon,
  history: HistoryIcon,
  host: ServerIcon,
  inbox: InboxIcon,
  jobs: ListIcon,
  keyboard: KeyboardIcon,
  loop: Repeat2Icon,
  mcp: PlugIcon,
  memory: BrainIcon,
  model: BoxIcon,
  news: NewspaperIcon,
  package: PackageIcon,
  pause: PauseIcon,
  pencil: PencilIcon,
  pin: PinIcon,
  plan: FileTextIcon,
  plus: PlusIcon,
  power: PowerIcon,
  prewalk: FootprintsIcon,
  prompt: MessageSquareIcon,
  question: CircleHelpIcon,
  redo: Redo2Icon,
  restart: RotateCcwIcon,
  rocket: RocketIcon,
  rule: ScrollTextIcon,
  session: CircleUserRoundIcon,
  settings: SettingsIcon,
  share: Share2Icon,
  shield: ShieldIcon,
  signIn: LogInIcon,
  signOut: LogOutIcon,
  stats: BarChart3Icon,
  stethoscope: StethoscopeIcon,
  swap: ArrowLeftRightIcon,
  todo: ListTodoIcon,
  tools: WrenchIcon,
  trash: Trash2Icon,
  tree: NetworkIcon,
  vibrate: VibrateIcon,
  voice: MicIcon,
  wave: WavesIcon,
};

const SKILL_SOURCE_LABEL_BY_KIND: Record<ProviderSkillSourceKind, string> = {
  app: "App",
  repo: "Repo",
  project: "Project",
  personal: "Personal",
  system: "System",
  other: "Provider",
};

function SkillSourceBadge(props: { kind: ProviderSkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = SKILL_SOURCE_ICON_BY_KIND[props.kind];
  return (
    <Badge className="ms-auto" variant="secondary">
      <Icon aria-hidden="true" className="text-current" />
      {SKILL_SOURCE_LABEL_BY_KIND[props.kind]}
      {props.showSkillSuffix ? " Skill" : null}
    </Badge>
  );
}
