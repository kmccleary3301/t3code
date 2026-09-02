import { normalizeThemeDefinition } from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import {
  importedAppearanceSnippets,
  previewCommandForPackage,
} from "./AppearanceCustomizationManager";

describe("importedAppearanceSnippets", () => {
  it("requires explicit enablement for every imported bundle snippet", () => {
    const imported = importedAppearanceSnippets([
      { id: "enabled-in-bundle", css: ":root { color: red; }", enabled: true, advanced: true },
      { id: "disabled-in-bundle", css: ":root { color: blue; }", enabled: false, advanced: false },
    ]);

    expect(imported.map((snippet) => snippet.enabled)).toEqual([false, false]);
    expect(imported.map((snippet) => snippet.id)).toEqual([
      "enabled-in-bundle",
      "disabled-in-bundle",
    ]);
  });
});

describe("previewCommandForPackage", () => {
  const profile = normalizeThemeDefinition(T3_CHAT_THEME);

  it("references the installed package instead of duplicating a potentially stale profile", () => {
    expect(previewCommandForPackage({ profile }, "full-app")).toEqual({
      type: "preview",
      preview: { packageId: profile.metadata.id },
    });
  });

  it("isolates theme-only previews and selects explicit appearance variants", () => {
    expect(previewCommandForPackage({ profile }, "theme-alone")).toEqual({
      type: "preview",
      preview: { packageId: profile.metadata.id, includeSnippets: false },
    });
    const darkVariant = profile.variants.find((variant) => variant.appearance === "dark");
    expect(previewCommandForPackage({ profile }, "dark")).toEqual({
      type: "preview",
      preview: {
        packageId: profile.metadata.id,
        ...(darkVariant === undefined ? {} : { variantId: darkVariant.id }),
      },
    });
  });
});
