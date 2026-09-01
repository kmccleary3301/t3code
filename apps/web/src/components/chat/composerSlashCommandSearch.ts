import type { ProviderDriverKind, ServerProviderSlashCommand } from "@t3tools/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import { buildProviderSlashArgumentCompletions } from "@t3tools/shared/providerSlashCommandCompletion";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { scoreProviderSkill } from "../../providerSkillSearch";

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "provider-slash-argument" | "skill" }
>;

export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  isAtPromptStart: boolean,
): SlashSearchItem[] {
  if (isAtPromptStart) {
    return [...items];
  }
  return items.filter((item) => item.type !== "skill");
}

function scoreSlashCommandItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    if (query === "skill") {
      return 0;
    }
    const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
    const skillScore = skillQuery ? scoreProviderSkill(item.skill, skillQuery) : 0;
    if (skillScore !== null) {
      return skillScore;
    }
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }

  const primaryValue =
    item.type === "slash-command"
      ? item.command.toLowerCase()
      : item.type === "provider-slash-command"
        ? item.command.name.toLowerCase()
        : item.searchValue.toLowerCase();
  const description = item.description.toLowerCase();

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
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

type SlashCommandItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" }
>;

export function mergeSlashCommandItems(
  builtInItems: ReadonlyArray<SlashCommandItem>,
  providerItems: ReadonlyArray<SlashCommandItem>,
): SlashCommandItem[] {
  const merged: SlashCommandItem[] = [];
  const commandNames = new Set<string>();
  for (const item of [...builtInItems, ...providerItems]) {
    const commandName = item.type === "slash-command" ? item.command : item.command.name;
    if (commandNames.has(commandName)) continue;
    commandNames.add(commandName);
    merged.push(item);
  }
  return merged;
}

export function buildProviderSlashArgumentItems(input: {
  readonly provider: ProviderDriverKind;
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly query: string;
}): { readonly items: SlashSearchItem[]; readonly searchQuery: string } | null {
  const completions = buildProviderSlashArgumentCompletions({
    commands: input.commands,
    query: input.query,
  });
  if (!completions) return null;

  return {
    items: completions.items.map(
      (completion): SlashSearchItem => ({
        id: `provider-slash-argument:${input.provider}:${completion.key}`,
        type: "provider-slash-argument",
        provider: input.provider,
        command: completion.command,
        insertText: completion.insertText,
        searchValue: completion.searchValue,
        label: completion.label,
        description: completion.description,
      }),
    ),
    searchQuery: completions.searchQuery,
  };
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: SlashSearchItem;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker:
          item.type === "slash-command"
            ? `0\u0000${item.command}`
            : item.type === "provider-slash-command"
              ? `1\u0000${item.command.name}\u0000${item.provider}`
              : item.type === "provider-slash-argument"
                ? `2\u0000${item.searchValue}\u0000${item.provider}`
                : `3\u0000${item.skill.name}\u0000${item.provider}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
