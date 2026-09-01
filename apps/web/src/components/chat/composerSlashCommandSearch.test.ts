import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  buildProviderSlashArgumentItems,
  mergeSlashCommandItems,
  searchSlashCommandItems,
} from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });

  it("keeps native aliases while removing built-in name collisions", () => {
    const builtIn = [
      {
        id: "slash:model",
        type: "slash-command",
        command: "model",
        label: "/model",
        description: "Switch response model",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;
    const provider = ["model", "models", "todo"].map(
      (name) =>
        ({
          id: `provider-slash-command:omp:${name}`,
          type: "provider-slash-command",
          provider: ProviderDriverKind.make("omp"),
          command: { name },
          label: `/${name}`,
          description: "OMP command",
        }) satisfies Extract<ComposerCommandItem, { type: "provider-slash-command" }>,
    );

    expect(mergeSlashCommandItems(builtIn, provider).map((item) => item.label)).toEqual([
      "/model",
      "/models",
      "/todo",
    ]);
  });

  it("completes OMP subcommands and static multi-argument values", () => {
    const provider = ProviderDriverKind.make("omp");
    const commands = [
      {
        name: "goal",
        description: "Manage goal mode",
        subcommands: [
          { name: "set", description: "Set the goal", usage: "<objective>" },
          { name: "budget", description: "Adjust token budget", usage: "<N|off>" },
        ],
      },
      { name: "fast", input: { hint: "[on|off|status]" } },
      {
        name: "mcp",
        subcommands: [
          {
            name: "add",
            usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
          },
        ],
      },
      {
        name: "memory",
        subcommands: [{ name: "mm list", usage: "[json|text]" }],
      },
      {
        name: "todo",
        subcommands: [{ name: "done", usage: "<task|phase>" }],
      },
    ];

    const subcommands = buildProviderSlashArgumentItems({
      provider,
      commands,
      query: "goal bud",
    });
    expect(subcommands?.searchQuery).toBe("bud");
    expect(
      subcommands
        ? searchSlashCommandItems(subcommands.items, subcommands.searchQuery).map((item) => ({
            label: item.label,
            description: item.description,
            insertText: item.type === "provider-slash-argument" ? item.insertText : null,
          }))
        : [],
    ).toEqual([
      {
        label: "/goal budget",
        description: "Adjust token budget · <N|off>",
        insertText: "/goal budget ",
      },
    ]);

    const argument = buildProviderSlashArgumentItems({
      provider,
      commands,
      query: "goal budget o",
    });
    expect(argument?.searchQuery).toBe("o");
    expect(argument?.items).toMatchObject([
      {
        label: "off",
        insertText: "/goal budget off ",
        searchValue: "off",
      },
    ]);

    const topLevelArgument = buildProviderSlashArgumentItems({
      provider,
      commands,
      query: "fast o",
    });
    expect(
      topLevelArgument
        ? searchSlashCommandItems(topLevelArgument.items, topLevelArgument.searchQuery).map(
            (item) => item.label,
          )
        : [],
    ).toEqual(["on", "off", "status"]);

    const flagValue = buildProviderSlashArgumentItems({
      provider,
      commands,
      query: "mcp add server --scope p",
    });
    expect(flagValue?.items.map((item) => item.label)).toEqual(["project", "user"]);

    const multiwordSubcommand = buildProviderSlashArgumentItems({
      provider,
      commands,
      query: "memory mm l",
    });
    expect(
      multiwordSubcommand
        ? searchSlashCommandItems(multiwordSubcommand.items, multiwordSubcommand.searchQuery).map(
            (item) => item.label,
          )
        : [],
    ).toEqual(["/memory mm list"]);

    expect(
      buildProviderSlashArgumentItems({
        provider,
        commands,
        query: "todo done ",
      })?.items,
    ).toEqual([]);
  });
});
