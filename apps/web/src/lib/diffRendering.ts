import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileDiffMetadata } from "@pierre/diffs/types";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;
export type DiffThemeName =
  | (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES]
  | (string & {});
let activeAppearanceDiffTheme: DiffThemeName | null = null;

export function setActiveAppearanceDiffTheme(themeName: string | null): void {
  activeAppearanceDiffTheme = themeName;
}

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return (
    activeAppearanceDiffTheme ?? (theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light)
  );
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  return files.reduce<DiffLineStat>(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines;
        total.deletions += hunk.deletionLines;
      }

      return total;
    },
    { additions: 0, deletions: 0 },
  );
}

interface RenderablePatchOptions {
  /**
   * Pierre's partial-patch parser keeps hunk render starts in source-file
   * coordinates. Its virtualizer iterates partial patches as compact rows, so
   * review diffs need compact render starts while retaining collapsedBefore
   * for the "N unmodified lines" separator.
   */
  compactPartialHunkOffsets?: boolean;
}

export function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;

  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = {
      ...hunk,
      splitLineStart,
      unifiedLineStart,
    };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compactHunk;
  });

  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
  options: RenderablePatchOptions = {},
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) =>
      options.compactPartialHunkOffsets
        ? parsedPatch.files.map(compactPartialHunkOffsets)
        : parsedPatch.files,
    );
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

/**
 * What the file was called before the change. Only a rename makes it differ from the current
 * path, and the hosts that resolve a diff position against both sides need both names.
 */
export function resolveFileDiffPreviousPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.prevName ?? fileDiff.name ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  const cacheKey = fileDiff.cacheKey;
  if (!cacheKey) return `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;

  return cacheKey.endsWith(":hydrated") ? cacheKey.slice(0, -":hydrated".length) : cacheKey;
}

export function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

/**
 * Maps every diff/file surface the @pierre/diffs renderer paints onto the
 * app's code tokens, so themed palettes reach the code body, gutter, and
 * row tints instead of the renderer's bundled colors. Shared by the diff
 * panel and the file preview.
 */
export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-interface) !important;
  --diffs-font-family: var(--font-code) !important;
  --diffs-light-bg: var(--diffs-bg) !important;
  --diffs-dark-bg: var(--diffs-bg) !important;
  --diffs-light: var(--diffs-fg, var(--code-foreground)) !important;
  --diffs-dark: var(--diffs-fg, var(--code-foreground)) !important;
  --diffs-bg-context-override: var(--diffs-bg-context, var(--diffs-bg)) !important;
  --diffs-bg-context-gutter-override: var(--diffs-bg-context-gutter, var(--diffs-bg)) !important;
  --diffs-bg-separator-override: var(--diffs-bg-separator, var(--diffs-bg)) !important;
  --diffs-bg-buffer-override: var(--diffs-bg-context, var(--diffs-bg)) !important;
  --diffs-addition-color-override: var(--diffs-addition-base, var(--success)) !important;
  --diffs-deletion-color-override: var(--diffs-deletion-base, var(--destructive)) !important;
  --diffs-modified-color-override: var(--diffs-modified-base, var(--warning)) !important;
  --diffs-bg-modification-override: var(--diffs-bg-modification, var(--diffs-bg)) !important;
  --diffs-fg-gutter-override: var(--diffs-fg-gutter, var(--diffs-fg)) !important;
  --diffs-fg-hunk-override: var(--diffs-fg-hunk, var(--diffs-fg)) !important;
  --diffs-bg-addition-override: var(--diffs-bg-addition, var(--diffs-bg)) !important;
  --diffs-bg-addition-number-override: var(--diffs-bg-addition, var(--diffs-bg)) !important;
  --diffs-bg-addition-hover-override: var(--diffs-bg-addition, var(--diffs-bg)) !important;
  --diffs-bg-addition-emphasis-override: var(--diffs-bg-addition, var(--diffs-bg)) !important;
  --diffs-bg-deletion-override: var(--diffs-bg-deletion, var(--diffs-bg)) !important;
  --diffs-bg-deletion-number-override: var(--diffs-bg-deletion, var(--diffs-bg)) !important;
  --diffs-bg-deletion-hover-override: var(--diffs-bg-deletion, var(--diffs-bg)) !important;
  --diffs-bg-deletion-emphasis-override: var(--diffs-bg-deletion, var(--diffs-bg)) !important;
  --diffs-bg-selection-override: var(--diffs-bg-selection, var(--diffs-bg)) !important;
  --diffs-fg-number-override: var(--diffs-fg-number, var(--diffs-fg)) !important;
  background-color: var(--diffs-bg) !important;
  color: var(--diffs-fg) !important;
}

[data-diffs-header] {
  background-color: var(--diffs-header-bg, var(--diffs-bg)) !important;
  color: var(--diffs-header-fg, var(--diffs-fg)) !important;
}

:is([data-diff], [data-file]) [data-gutter-buffer],
:is([data-diff], [data-file])
  [data-column-number]:not([data-line-type="change-addition"]):not([data-line-type="change-deletion"]) {
  color: var(--diffs-fg-gutter-override, var(--diffs-fg)) !important;
}

:is([data-diff], [data-file]) [data-separator] [data-separator-content],
:is([data-diff], [data-file]) [data-separator] [data-expand-button] {
  color: var(--diffs-fg-hunk-override, var(--diffs-fg)) !important;
}
`;
