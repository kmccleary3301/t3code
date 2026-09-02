import { describe, expect, it } from "vite-plus/test";
import { normalizeThemeDefinition } from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import {
  DIFF_SURFACE_THEME_UNSAFE_CSS,
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getDiffLineStat,
  getRenderablePatch,
} from "./diffRendering";
import { appearanceVariantDeclarations, diffAppearanceVariables } from "./appearanceAdapters";

const canonicalProfile = normalizeThemeDefinition(T3_CHAT_THEME, { platform: "web" });
const canonicalVariant =
  canonicalProfile.variants.find((candidate) => candidate.id === "dark") ??
  canonicalProfile.variants[0];
if (canonicalVariant === undefined) throw new Error("Conformance fixture has no variant.");

describe("normalized diff renderer palette", () => {
  it("forwards every diff role through inline variables and the scoped bridge", () => {
    const expected = {
      "--diffs-bg": canonicalVariant.diff.background,
      "--diffs-fg": canonicalVariant.diff.foreground,
      "--diffs-bg-context": canonicalVariant.diff.gutterBackground,
      "--diffs-bg-context-gutter": canonicalVariant.diff.gutterBackground,
      "--diffs-bg-separator": canonicalVariant.diff.hunkBackground,
      "--diffs-fg-number": canonicalVariant.diff.lineNumberForeground,
      "--diffs-addition-base": canonicalVariant.diff.additionForeground,
      "--diffs-deletion-base": canonicalVariant.diff.deletionForeground,
      "--diffs-modified-base": canonicalVariant.diff.modificationForeground,
      "--diffs-bg-modification": canonicalVariant.diff.modificationBackground,
      "--diffs-fg-gutter": canonicalVariant.diff.gutterForeground,
      "--diffs-fg-hunk": canonicalVariant.diff.hunkForeground,
      "--diffs-bg-addition": canonicalVariant.diff.additionBackground,
      "--diffs-bg-deletion": canonicalVariant.diff.deletionBackground,
      "--diffs-bg-selection": canonicalVariant.diff.selectionBackground,
      "--diffs-annotation-bg": canonicalVariant.diff.commentBackground,
      "--diffs-header-bg": canonicalVariant.diff.headerBackground,
      "--diffs-header-fg": canonicalVariant.diff.headerForeground,
    };

    expect(diffAppearanceVariables(canonicalVariant.diff)).toEqual(expected);
    const declarations = appearanceVariantDeclarations(canonicalVariant);
    for (const [name, value] of Object.entries(expected)) {
      expect(declarations).toContain(`${name}:${value};`);
    }
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain(
      "--diffs-bg-modification-override: var(--diffs-bg-modification, var(--diffs-bg))",
    );
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain(
      "--diffs-fg-gutter-override: var(--diffs-fg-gutter, var(--diffs-fg))",
    );
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain(
      "--diffs-fg-hunk-override: var(--diffs-fg-hunk, var(--diffs-fg))",
    );
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain(
      ":is([data-diff], [data-file]) [data-gutter-buffer]",
    );
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain("[data-column-number]");
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain(
      ":is([data-diff], [data-file]) [data-separator] [data-separator-content]",
    );
  });
});

describe("buildPatchCacheKey", () => {
  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getRenderablePatch", () => {
  it("compacts partial hunk render offsets for virtualized review diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "index 1111111..2222222 100644",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,4 +48,4 @@",
      " context",
      "-before",
      "+after",
      " context",
      " context",
      "@@ -80,3 +80,4 @@",
      " context",
      "+added",
      " context",
      " context",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "review", {
      compactPartialHunkOffsets: true,
    });
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file?.hunks[0]?.collapsedBefore).toBe(47);
    expect(file?.hunks[0]?.unifiedLineStart).toBe(0);
    expect(file?.hunks[1]?.collapsedBefore).toBeGreaterThan(0);
    expect(file?.hunks[1]?.unifiedLineStart).toBe(file?.hunks[0]?.unifiedLineCount);
    expect(file?.unifiedLineCount).toBe(
      file?.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0),
    );
  });

  it("retains source-file offsets for checkpoint diffs", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -48,1 +48,1 @@",
      "-before",
      "+after",
    ].join("\n");

    const parsed = getRenderablePatch(patch, "checkpoint");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files[0]?.hunks[0]?.unifiedLineStart).toBe(47);
  });
});

describe("buildFileDiffRenderKey", () => {
  it("keeps file identity stable when Pierre hydrates a partial diff", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");
    const parsed = getRenderablePatch(patch, "hydrated-key");
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    const file = parsed.files[0];
    expect(file).toBeDefined();
    if (!file) return;
    const key = buildFileDiffRenderKey(file);
    file.cacheKey = `${file.cacheKey}:hydrated`;

    expect(buildFileDiffRenderKey(file)).toBe(key);
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const parsed = getRenderablePatch(patch);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;

    expect(getDiffLineStat(parsed.files)).toEqual({ additions: 3, deletions: 2 });
  });
});
