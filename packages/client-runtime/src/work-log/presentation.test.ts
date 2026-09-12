import { describe, expect, it } from "@effect/vitest";

import {
  toolGroupAction,
  workLogEntryIsLocalCodeSearch,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

const baseEntry = {
  label: "Native tool",
  tone: "tool",
} satisfies Pick<WorkLogPresentationEntry, "label" | "tone">;

describe("work-log tool classification", () => {
  it("classifies native grep, glob, and find-files calls as code search", () => {
    for (const toolTitle of ["Grep", "Glob", "Find Files", "Find-Files"]) {
      const entry = {
        ...baseEntry,
        itemType: "dynamic_tool_call" as const,
        toolTitle,
      };
      expect(workLogEntryIsLocalCodeSearch(entry)).toBe(true);
      expect(toolGroupAction(entry)).toBe("code-search");
    }
  });

  it("does not classify an unrelated dynamic tool as code search", () => {
    expect(
      workLogEntryIsLocalCodeSearch({
        ...baseEntry,
        itemType: "dynamic_tool_call",
        toolTitle: "Read File",
      }),
    ).toBe(false);
  });

  it("recognizes grep-shaped web search rows", () => {
    expect(
      toolGroupAction({
        ...baseEntry,
        itemType: "web_search",
        toolTitle: "grep",
      }),
    ).toBe("code-search");
  });
});
