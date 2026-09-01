import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("detectComposerTrigger", () => {
  it("keeps native command arguments in the slash trigger", () => {
    expect(detectComposerTrigger("/goal budget o", 14)).toEqual({
      kind: "slash-command",
      query: "goal budget o",
      rangeStart: 0,
      rangeEnd: 14,
    });
  });

  it("preserves indentation before a native command", () => {
    expect(detectComposerTrigger("  /goal bud", 11)).toEqual({
      kind: "slash-command",
      query: "goal bud",
      rangeStart: 2,
      rangeEnd: 11,
    });
  });

  it("keeps model argument detection intact", () => {
    expect(detectComposerTrigger("/model claude", 13)).toEqual({
      kind: "slash-model",
      query: "claude",
      rangeStart: 0,
      rangeEnd: 13,
    });
  });
});
