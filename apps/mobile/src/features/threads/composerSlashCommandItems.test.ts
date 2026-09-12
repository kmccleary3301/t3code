import { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger, replaceTextRange } from "@t3tools/shared/composerTrigger";
import ompCompletionFixture from "../../../../../packages/shared/src/ompSlashCompletionFixture.json";

import { buildMobileSlashCommandItems } from "./composerSlashCommandItems";

const liveOmpCommands = Schema.decodeUnknownSync(Schema.Array(ServerProviderSlashCommand))(
  ompCompletionFixture.catalog,
);

const commands = [
  { name: "model", description: "Native model command" },
  { name: "models", description: "List native models" },
  {
    name: "goal",
    description: "Manage goal mode",
    subcommands: [
      { name: "set", description: "Set goal", usage: "<objective>" },
      { name: "budget", description: "Adjust token budget", usage: "<N|off>" },
    ],
  },
];

describe("buildMobileSlashCommandItems", () => {
  it("matches live OMP command ordering for representative queries", () => {
    const queries = ["s", "se", "set", "goal"] as const;
    for (const query of queries) {
      const actual = buildMobileSlashCommandItems({
        commands: liveOmpCommands,
        query,
        includeInteractionModeCommands: false,
        preferProviderCommands: true,
      }).map((item) => item.label);
      expect(actual, query).toEqual(ompCompletionFixture[query].map((row) => `/${row.label}`));
    }
  });

  it("keeps built-in collisions out while retaining native aliases", () => {
    expect(
      buildMobileSlashCommandItems({ commands, query: "model" }).map((item) => item.label),
    ).toEqual(["/model", "/models"]);
  });

  it("lets native commands replace app-local collisions", () => {
    expect(
      buildMobileSlashCommandItems({
        commands: [{ name: "plan", description: "Native plan command" }],
        query: "plan",
        preferProviderCommands: true,
      }),
    ).toMatchObject([
      {
        type: "provider-slash-command",
        label: "/plan",
        description: "Native plan command",
      },
    ]);
  });

  it("maps nested native metadata to selectable mobile items", () => {
    expect(buildMobileSlashCommandItems({ commands, query: "goal bud" })).toMatchObject([
      {
        type: "provider-slash-argument",
        label: "/goal budget",
        insertText: "/goal budget ",
      },
    ]);
    expect(buildMobileSlashCommandItems({ commands, query: "goal budget o" })).toMatchObject([
      {
        type: "provider-slash-argument",
        label: "off",
        insertText: "/goal budget off ",
      },
    ]);
  });

  it("collapses provider skills into a namespace and matches bare skill names", () => {
    const skillCommands = [
      { name: "skill:frontend", source: "skill" as const, usage: 3 },
      { name: "skill:backend", source: "skill" as const, usage: 1 },
      { name: "goal", description: "Manage goal mode" },
    ];

    expect(
      buildMobileSlashCommandItems({
        commands: skillCommands,
        query: "",
        includeInteractionModeCommands: false,
      }).map((item) => item.label),
    ).toContain("/skill:");
    expect(
      buildMobileSlashCommandItems({
        commands: skillCommands,
        query: "front",
        includeInteractionModeCommands: false,
      }).map((item) => item.label),
    ).toEqual(["/skill:frontend"]);
  });

  it("uses provider usage to break empty-query ties", () => {
    const usageCommands = [
      { name: "alpha", usage: 1 },
      { name: "beta", usage: 8 },
    ];
    expect(
      buildMobileSlashCommandItems({
        commands: usageCommands,
        query: "",
        includeInteractionModeCommands: false,
      })
        .filter((item) => item.type === "provider-slash-command")
        .map((item) => item.command.name),
    ).toEqual(["beta", "alpha"]);
  });

  it("replaces a nested mobile composer trigger end to end", () => {
    const text = "  /goal budget o";
    const trigger = detectComposerTrigger(text, text.length);
    expect(trigger?.kind).toBe("slash-command");
    if (trigger?.kind !== "slash-command") return;

    const item = buildMobileSlashCommandItems({ commands, query: trigger.query })[0];
    expect(item?.type).toBe("provider-slash-argument");
    if (item?.type !== "provider-slash-argument") return;

    expect(replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, item.insertText)).toEqual({
      text: "  /goal budget off ",
      cursor: 19,
    });
  });
});
