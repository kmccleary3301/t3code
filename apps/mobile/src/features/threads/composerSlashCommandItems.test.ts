import { describe, expect, it } from "vite-plus/test";
import { detectComposerTrigger, replaceTextRange } from "@t3tools/shared/composerTrigger";

import { buildMobileSlashCommandItems } from "./composerSlashCommandItems";

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
  it("keeps built-in collisions out while retaining native aliases", () => {
    expect(
      buildMobileSlashCommandItems({ commands, query: "model" }).map((item) => item.label),
    ).toEqual(["/model", "/models"]);
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
