import { describe, expect, it } from "vite-plus/test";

import { normalizeThemeDefinition } from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";

import {
  buildGhosttyThemeConfig,
  getProfileTerminalTheme,
} from "../features/terminal/terminalTheme";
import { buildMobileGhosttyConfig, compileMobileAppearance } from "./mobileAppearanceAdapter";

const profile = normalizeThemeDefinition(T3_CHAT_THEME);
const typographyFixtureProfile = {
  ...profile,
  variants: profile.variants.map((variant) =>
    variant.id === "dark"
      ? {
          ...variant,
          typography: {
            ...variant.typography,
            terminal: {
              ...variant.typography.terminal,
              families: ["Fixture Mono", "ui-monospace"],
              sizePx: 14,
              weight: 650,
              lineHeight: 1.6,
              letterSpacingEm: 0.02,
              ligatures: false,
              featureSettings: { liga: 0, ss01: 1 },
              variableAxes: { opsz: 13, wght: 650 },
            },
          },
        }
      : variant,
  ),
};

const expectedNativeDark = {
  appearance: "dark",
  variantId: "dark",
  profileId: "t3-chat",
  previewCanvas: "#2a1928",
};

describe("compileMobileAppearance", () => {
  it("maps one normalized profile into native and Uniwind outputs", () => {
    const output = compileMobileAppearance(profile, "dark");

    expect(output.profileId).toBe(expectedNativeDark.profileId);
    expect(output.variantId).toBe(expectedNativeDark.variantId);
    expect(output.appearance).toBe(expectedNativeDark.appearance);
    expect(output.uniwindVariables["--color-screen"]).toMatch(/^#/);
    expect(output.uniwindVariables["--font-size-terminal"]).toBe(
      profile.variants.find((variant) => variant.id === "dark")?.typography.terminal.sizePx,
    );
    expect(output.rendererPalettes.terminal.palette).toHaveLength(16);
    expect(output.rendererPalettes.terminal.selection).toMatch(/^#/);
    expect(output.native.navigation.dark).toBe(true);
    expect(output.native.sheet.background).toMatch(/^#/);
    expect(output.native.editor.font.family).toBe("ui-monospace");
    expect(output.unsupported).toEqual([
      "css",
      "package-fonts",
      "artwork-assets",
      "motion-effects",
    ]);
  });

  it("maps every normalized typography field into mobile outputs", () => {
    const output = compileMobileAppearance(typographyFixtureProfile, "dark");
    const terminal = output.typographyPreferences.terminal;

    expect(terminal).toEqual({
      families: ["Fixture Mono", "ui-monospace"],
      family: "Fixture Mono",
      sizePx: 14,
      weight: 650,
      lineHeight: 1.6,
      letterSpacingEm: 0.02,
      ligatures: false,
      featureSettings: { liga: 0, ss01: 1 },
      variableAxes: { opsz: 13, wght: 650 },
    });
    expect(output.rendererPalettes.terminal).toMatchObject({
      fontFamily: "Fixture Mono",
      fontSize: 14,
      fontWeight: 650,
      lineHeight: 1.6,
      letterSpacingEm: 0.02,
      ligatures: false,
      featureSettings: { liga: 0, ss01: 1 },
      variableAxes: { opsz: 13, wght: 650 },
    });
    expect(output.uniwindVariables).toMatchObject({
      "--font-terminal": "Fixture Mono",
      "--font-size-terminal": 14,
      "--font-weight-terminal": 650,
      "--line-height-terminal": 1.6,
      "--letter-spacing-terminal": 0.02,
      "--font-variant-ligatures-terminal": "none",
      "--font-feature-settings-terminal": '"liga" 0, "ss01" 1',
      "--font-variation-settings-terminal": '"opsz" 13, "wght" 650',
    });
  });

  it("uses the declared default variant deterministically when appearance is absent", () => {
    const lightOnly = {
      ...profile,
      variants: profile.variants.filter((variant) => variant.appearance === "light"),
      fallback: { light: "default-variant", dark: "default-variant" } as const,
      defaultVariant: "light",
    };
    const output = compileMobileAppearance(lightOnly, "dark");
    expect(output.variantId).toBe("light");
    expect(output.appearance).toBe("dark");
  });

  it("does not execute stylesheets or assets", () => {
    const output = compileMobileAppearance(profile, "light");
    expect(output.uniwindVariables).not.toHaveProperty("css");
    expect(output.native).not.toHaveProperty("assets");
    expect(output.unsupported).toContain("css");
  });
});

describe("mobile Ghostty profile output", () => {
  it("serializes ANSI colors and Ghostty-supported terminal typography", () => {
    const output = compileMobileAppearance(typographyFixtureProfile, "dark");
    const config = buildMobileGhosttyConfig(output.rendererPalettes.terminal);
    expect(config).toContain("selection-background = ");
    expect(config).toContain("font-size = 14");
    expect(config).toContain("font-feature = -calt,-liga,-dlig");
    expect(config).toContain('font-feature = "liga" 0');
    expect(config).toContain('font-feature = "ss01" 1');
    expect(config).toContain('font-variation = "opsz"=13');
    expect(config).toContain('font-variation = "wght"=650');
    expect(config).not.toContain("scrollbar-color = ");
    expect(config.match(/^palette = /gmu)).toHaveLength(16);

    const legacySurfaceTheme = getProfileTerminalTheme(typographyFixtureProfile, "dark");
    const legacyConfig = buildGhosttyThemeConfig(legacySurfaceTheme);
    expect(legacyConfig).toContain("selection-background = ");
    expect(legacyConfig).toContain('font-variation = "wght"=650');
  });
});
