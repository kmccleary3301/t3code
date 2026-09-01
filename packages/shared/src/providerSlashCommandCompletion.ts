import type { ServerProviderSlashCommand, ServerProviderSlashSubcommand } from "@t3tools/contracts";

export interface ProviderSlashArgumentCompletion {
  readonly key: string;
  readonly command: ServerProviderSlashCommand;
  readonly insertText: string;
  readonly searchValue: string;
  readonly label: string;
  readonly description: string;
}

export interface ProviderSlashArgumentCompletionResult {
  readonly items: ReadonlyArray<ProviderSlashArgumentCompletion>;
  readonly searchQuery: string;
}

function subcommandDescription(subcommand: ServerProviderSlashSubcommand): string {
  if (subcommand.description && subcommand.usage) {
    return `${subcommand.description} · ${subcommand.usage}`;
  }
  return subcommand.description ?? subcommand.usage ?? "Run provider subcommand";
}

function usageSyntaxTokens(usage: string): string[] {
  const groups = usage.match(/\[[^\]]+\]|<[^>]+>|\S+/g) ?? [];
  return groups.flatMap((group) => {
    const unwrapped = group.startsWith("[") && group.endsWith("]") ? group.slice(1, -1) : group;
    return unwrapped.split(/\s+/).filter(Boolean);
  });
}

function syntaxTokenChoices(syntaxToken: string): string[] {
  const angleWrapped = syntaxToken.startsWith("<") && syntaxToken.endsWith(">");
  const unwrapped = angleWrapped ? syntaxToken.slice(1, -1) : syntaxToken;
  const values = unwrapped.split("|").filter(Boolean);
  if (values.length === 1) return values[0]?.startsWith("-") ? values : [];
  if (!angleWrapped) return values;

  const hasVariableAlternative = values.some((value) => /^[A-Z][A-Za-z0-9_-]*$/u.test(value));
  return hasVariableAlternative ? values.filter((value) => /^[a-z][a-z0-9_-]*$/u.test(value)) : [];
}

function usageArgumentChoices(
  usage: string,
  argumentText: string,
): { readonly prefix: string; readonly insertionPrefix: string; readonly values: string[] } | null {
  const syntax = usageSyntaxTokens(usage);
  if (syntax.length === 0) return null;
  const normalized = argumentText.trimStart();
  const endsWithWhitespace = /\s$/u.test(normalized);
  const inputTokens = normalized.length === 0 ? [] : normalized.trimEnd().split(/\s+/);
  const completedTokens = endsWithWhitespace ? inputTokens : inputTokens.slice(0, -1);
  const prefix = endsWithWhitespace ? "" : (inputTokens.at(-1) ?? "");
  const argumentIndex = completedTokens.length;
  const previousToken = completedTokens.at(-1);
  const values: string[] = [];

  if (previousToken?.startsWith("--")) {
    const flagIndex = syntax.indexOf(previousToken);
    if (flagIndex !== -1) values.push(...syntaxTokenChoices(syntax[flagIndex + 1] ?? ""));
  } else {
    values.push(...syntaxTokenChoices(syntax[argumentIndex] ?? ""));
    if (prefix.length === 0 || prefix.startsWith("-")) {
      const used = new Set(completedTokens);
      values.push(...syntax.filter((token) => token.startsWith("--") && !used.has(token)));
    }
  }

  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length === 0) return null;
  const insertionPrefix = endsWithWhitespace
    ? normalized
    : normalized.slice(0, Math.max(0, normalized.length - prefix.length));
  return { prefix, insertionPrefix, values: uniqueValues };
}

export function buildProviderSlashArgumentCompletions(input: {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly query: string;
}): ProviderSlashArgumentCompletionResult | null {
  const commandSpace = input.query.indexOf(" ");
  if (commandSpace === -1) return null;
  const commandName = input.query.slice(0, commandSpace);
  const command = input.commands.find((candidate) => candidate.name === commandName);
  if (!command) return { items: [], searchQuery: "" };

  const argumentText = input.query.slice(commandSpace + 1).trimStart();
  const subcommands = command.subcommands ?? [];
  const selectedSubcommand = [...subcommands]
    .sort((left, right) => right.name.length - left.name.length)
    .find((candidate) => argumentText.startsWith(`${candidate.name} `));
  if (!selectedSubcommand) {
    if (subcommands.length > 0) {
      return {
        items: subcommands.map((subcommand) => ({
          key: `${command.name}:${subcommand.name}`,
          command,
          insertText: `/${command.name} ${subcommand.name} `,
          searchValue: subcommand.name,
          label: `/${command.name} ${subcommand.name}`,
          description: subcommandDescription(subcommand),
        })),
        searchQuery: argumentText,
      };
    }

    const choices = command.input?.hint
      ? usageArgumentChoices(command.input.hint, argumentText)
      : null;
    if (!choices) return { items: [], searchQuery: "" };
    return {
      items: choices.values.map((value) => ({
        key: `${command.name}:${value}`,
        command,
        insertText: `/${command.name} ${choices.insertionPrefix}${value} `,
        searchValue: value,
        label: value,
        description: command.description ?? command.input?.hint ?? "Native command argument",
      })),
      searchQuery: choices.prefix,
    };
  }

  if (!selectedSubcommand.usage) return { items: [], searchQuery: "" };
  const valueText = argumentText.slice(selectedSubcommand.name.length + 1);
  const choices = usageArgumentChoices(selectedSubcommand.usage, valueText);
  if (!choices) return { items: [], searchQuery: "" };
  return {
    items: choices.values.map((value) => ({
      key: `${command.name}:${selectedSubcommand.name}:${value}`,
      command,
      insertText: `/${command.name} ${selectedSubcommand.name} ${choices.insertionPrefix}${value} `,
      searchValue: value,
      label: value,
      description: subcommandDescription(selectedSubcommand),
    })),
    searchQuery: choices.prefix,
  };
}
