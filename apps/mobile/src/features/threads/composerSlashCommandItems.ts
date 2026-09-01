import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { buildProviderSlashArgumentCompletions } from "@t3tools/shared/providerSlashCommandCompletion";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

type SlashCommandItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "provider-slash-argument" }
>;

const BUILT_IN_COMMANDS = [
  {
    id: "cmd:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch model",
  },
  {
    id: "cmd:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch to plan mode",
  },
  {
    id: "cmd:default",
    type: "slash-command",
    command: "default",
    label: "/default",
    description: "Switch to default mode",
  },
] as const satisfies ReadonlyArray<SlashCommandItem>;

function commandDescription(command: ServerProviderSlashCommand): string {
  if (command.description && command.input?.hint) {
    return `${command.description} · ${command.input.hint}`;
  }
  return command.description ?? command.input?.hint ?? "Run provider command";
}

function scoreSlashCommandItem(item: SlashCommandItem, query: string): number | null {
  const primaryValue =
    item.type === "slash-command"
      ? item.command.toLowerCase()
      : item.type === "provider-slash-command"
        ? item.command.name.toLowerCase()
        : item.searchValue.toLowerCase();
  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: item.description.toLowerCase(),
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}

function searchSlashCommandItems(
  items: ReadonlyArray<SlashCommandItem>,
  query: string,
): SlashCommandItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) return [...items];

  const ranked: Array<{ item: SlashCommandItem; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      { item, score, tieBreaker: item.label.toLowerCase() },
      items.length,
    );
  }
  return ranked.map(({ item }) => item);
}

export function buildMobileSlashCommandItems(input: {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly query: string;
}): SlashCommandItem[] {
  const argumentCompletions = buildProviderSlashArgumentCompletions(input);
  if (argumentCompletions) {
    const items = argumentCompletions.items.map(
      (completion): SlashCommandItem => ({
        id: `provider-slash-argument:${completion.key}`,
        type: "provider-slash-argument",
        command: completion.command,
        insertText: completion.insertText,
        searchValue: completion.searchValue,
        label: completion.label,
        description: completion.description,
      }),
    );
    return searchSlashCommandItems(items, argumentCompletions.searchQuery);
  }

  const commandNames = new Set<string>(BUILT_IN_COMMANDS.map((item) => item.command));
  const providerItems: SlashCommandItem[] = [];
  for (const command of input.commands) {
    if (commandNames.has(command.name)) continue;
    commandNames.add(command.name);
    providerItems.push({
      id: `provider-slash-command:${command.name}`,
      type: "provider-slash-command",
      command,
      label: `/${command.name}`,
      description: commandDescription(command),
    });
  }
  return searchSlashCommandItems([...BUILT_IN_COMMANDS, ...providerItems], input.query);
}
