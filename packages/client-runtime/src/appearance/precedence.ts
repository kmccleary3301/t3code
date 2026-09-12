import type { AppearanceLayer, AppearancePrecedenceLayers } from "./model.ts";

/** Low-priority layers are listed first; later layers win per property. */
export const APPEARANCE_PRECEDENCE = [
  "variant",
  "packageCss",
  "preference",
  "ordinarySnippet",
  "preview",
  "accessibility",
  "advancedSnippet",
] as const;

function mergeLayer(target: Record<string, string>, layer: AppearanceLayer): void {
  for (const key of Object.keys(layer)) {
    const value = layer[key];
    if (value !== undefined) target[key] = value;
  }
}

/**
 * Resolve appearance declarations in their documented order. Safe-mode callers
 * may supply a fixed built-in variant, but persisted preference and
 * accessibility colors are never retained.
 */
export function resolveAppearancePrecedence(
  layers: AppearancePrecedenceLayers,
  safeMode = false,
): AppearanceLayer {
  const merged: Record<string, string> = {};
  mergeLayer(merged, layers.variant);
  if (!safeMode) {
    mergeLayer(merged, layers.packageCss);
    mergeLayer(merged, layers.preference);
    mergeLayer(merged, layers.ordinarySnippet);
    mergeLayer(merged, layers.preview);
    mergeLayer(merged, layers.accessibility);
  }
  if (!safeMode) mergeLayer(merged, layers.advancedSnippet);

  const ordered: Record<string, string> = {};
  for (const key of Object.keys(merged).sort()) {
    const value = merged[key];
    if (value !== undefined) ordered[key] = value;
  }
  return ordered;
}
