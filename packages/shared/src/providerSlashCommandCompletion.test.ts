import { describe, expect, it } from "vite-plus/test";

import { buildProviderSlashArgumentCompletions } from "./providerSlashCommandCompletion.ts";

const commands = [
  {
    name: "goal",
    subcommands: [
      { name: "set", description: "Set the goal", usage: "<objective>" },
      { name: "budget", description: "Adjust token budget", usage: "<N|off>" },
    ],
  },
  { name: "fast", input: { hint: "[on|off|status]" } },
  {
    name: "mcp",
    subcommands: [
      { name: "add", usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]" },
    ],
  },
  { name: "memory", subcommands: [{ name: "mm list", usage: "[json|text]" }] },
  { name: "todo", subcommands: [{ name: "done", usage: "<task|phase>" }] },
];

describe("buildProviderSlashArgumentCompletions", () => {
  it("completes subcommands and later static values", () => {
    const subcommands = buildProviderSlashArgumentCompletions({ commands, query: "goal bud" });
    expect(subcommands?.searchQuery).toBe("bud");
    expect(subcommands?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "/goal budget", insertText: "/goal budget " }),
      ]),
    );
    expect(
      buildProviderSlashArgumentCompletions({ commands, query: "goal budget o" }),
    ).toMatchObject({
      searchQuery: "o",
      items: [{ label: "off", insertText: "/goal budget off " }],
    });
  });

  it("supports top-level alternatives, flag values, and multiword subcommands", () => {
    expect(
      buildProviderSlashArgumentCompletions({ commands, query: "fast o" })?.items.map(
        (item) => item.label,
      ),
    ).toEqual(["on", "off", "status"]);
    expect(
      buildProviderSlashArgumentCompletions({
        commands,
        query: "mcp add server --scope p",
      })?.items.map((item) => item.label),
    ).toEqual(["project", "user"]);
    expect(buildProviderSlashArgumentCompletions({ commands, query: "memory mm l" })).toMatchObject(
      {
        searchQuery: "mm l",
        items: [{ label: "/memory mm list", insertText: "/memory mm list " }],
      },
    );
  });

  it("does not fabricate values for native free-form placeholders", () => {
    expect(buildProviderSlashArgumentCompletions({ commands, query: "todo done " })?.items).toEqual(
      [],
    );
  });
});
