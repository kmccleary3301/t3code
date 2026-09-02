import { createMobileThemeVariables, themeColorToNativeColor } from "./mobileTheme";
import type {
  AppearanceAnsi,
  AppearanceTypographyRole,
  NormalizedAppearanceProfile,
  NormalizedAppearanceVariant,
  TypographyValue,
} from "@t3tools/shared/appearance";

const TYPOGRAPHY_ROLES = [
  "interface",
  "composer",
  "code",
  "terminal",
  "markdown",
  "label",
  "heading",
] as const satisfies ReadonlyArray<AppearanceTypographyRole>;

const ANSI_ROLES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies ReadonlyArray<keyof AppearanceAnsi>;

export interface MobileTypographyRole {
  readonly families: ReadonlyArray<string>;
  readonly family: string;
  readonly sizePx: number;
  readonly weight: number;
  readonly lineHeight: number;
  readonly letterSpacingEm: number;
  readonly ligatures: boolean;
  readonly featureSettings: Readonly<Record<string, number>>;
  readonly variableAxes: Readonly<Record<string, number>>;
}

export type MobileTypographyPreferences = Readonly<
  Record<AppearanceTypographyRole, MobileTypographyRole>
>;

export interface MobileTerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selection: string;
  readonly scrollbar: string;
  readonly scrollbarHover: string;
  readonly ansi: Readonly<AppearanceAnsi>;
  readonly palette: ReadonlyArray<string>;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly lineHeight: number;
  readonly letterSpacingEm: number;
  readonly ligatures: boolean;
  readonly featureSettings: Readonly<Record<string, number>>;
  readonly variableAxes: Readonly<Record<string, number>>;
}

export interface GhosttyTypographyConfig {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly ligatures?: boolean;
  readonly featureSettings?: Readonly<Record<string, number>>;
  readonly variableAxes?: Readonly<Record<string, number>>;
}

export interface MobileRendererPalette {
  readonly terminal: MobileTerminalTheme;
  readonly review: Readonly<{
    readonly background: string;
    readonly foreground: string;
    readonly additionBackground: string;
    readonly additionForeground: string;
    readonly deletionBackground: string;
    readonly deletionForeground: string;
    readonly modificationBackground: string;
    readonly modificationForeground: string;
    readonly gutterBackground: string;
    readonly gutterForeground: string;
    readonly lineNumberForeground: string;
    readonly hunkBackground: string;
    readonly hunkForeground: string;
    readonly selectionBackground: string;
    readonly commentBackground: string;
    readonly headerBackground: string;
    readonly headerForeground: string;
  }>;
  readonly preview: Readonly<{
    readonly canvas: string;
    readonly accent: string;
    readonly messageAction: string;
  }>;
}

export interface MobileNativeAppearance {
  readonly navigation: Readonly<{
    readonly dark: boolean;
    readonly primary: string;
    readonly background: string;
    readonly card: string;
    readonly text: string;
    readonly border: string;
    readonly notification: string;
    readonly header: Readonly<{
      readonly background: string;
      readonly foreground: string;
      readonly border: string;
    }>;
  }>;
  readonly sheet: Readonly<{
    readonly background: string;
    readonly foreground: string;
    readonly border: string;
    readonly handle: string;
  }>;
  readonly menu: Readonly<{
    readonly background: string;
    readonly foreground: string;
    readonly selected: string;
    readonly border: string;
  }>;
  readonly composer: Readonly<{
    readonly background: string;
    readonly foreground: string;
    readonly placeholder: string;
    readonly border: string;
    readonly accent: string;
  }>;
  readonly editor: Readonly<{
    readonly background: string;
    readonly foreground: string;
    readonly selection: string;
    readonly font: MobileTypographyRole;
  }>;
  readonly filePreview: Readonly<{
    readonly background: string;
    readonly foreground: string;
    readonly tint: string;
  }>;
  readonly controls: Readonly<{
    readonly accent: string;
    readonly accentForeground: string;
    readonly inactiveTrack: string;
    readonly inactiveThumb: string;
    readonly danger: string;
    readonly focus: string;
  }>;
}

export interface MobileAppearanceOutput {
  readonly profileId: string;
  readonly variantId: string;
  readonly appearance: "light" | "dark";
  readonly uniwindVariables: Readonly<Record<string, string | number>>;
  readonly typographyPreferences: MobileTypographyPreferences;
  readonly rendererPalettes: MobileRendererPalette;
  readonly native: MobileNativeAppearance;
  readonly unsupported: ReadonlyArray<
    "css" | "package-fonts" | "artwork-assets" | "motion-effects"
  >;
}

function variantForAppearance(
  profile: NormalizedAppearanceProfile,
  appearance: "light" | "dark",
): NormalizedAppearanceVariant {
  const exact = profile.variants.find((variant) => variant.appearance === appearance);
  if (exact !== undefined) return exact;
  const fallbackId =
    profile.fallback[appearance] === "default-variant" ? profile.defaultVariant : null;
  const fallback =
    fallbackId === null ? undefined : profile.variants.find((variant) => variant.id === fallbackId);
  if (fallback !== undefined) return fallback;
  return profile.variants[0]!;
}

function typographyRole(value: TypographyValue): MobileTypographyRole {
  return {
    families: value.families,
    family: value.families[0]!,
    sizePx: value.sizePx,
    weight: value.weight,
    lineHeight: value.lineHeight,
    letterSpacingEm: value.letterSpacingEm,
    ligatures: value.ligatures,
    featureSettings: value.featureSettings ?? {},
    variableAxes: value.variableAxes,
  };
}

function typographyPreferences(variant: NormalizedAppearanceVariant): MobileTypographyPreferences {
  return Object.fromEntries(
    TYPOGRAPHY_ROLES.map((role) => [role, typographyRole(variant.typography[role])]),
  ) as MobileTypographyPreferences;
}

function nativeColor(value: string): string {
  return themeColorToNativeColor(value);
}

function quoteGhosttyIdentifier(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildGhosttyTypographyConfig(
  typography: GhosttyTypographyConfig,
): ReadonlyArray<string> {
  const lines: string[] = [];
  if (typography.fontFamily !== undefined) lines.push(`font-family = ${typography.fontFamily}`);
  if (typography.fontSize !== undefined) lines.push(`font-size = ${typography.fontSize}`);
  if (typography.ligatures === false) lines.push("font-feature = -calt,-liga,-dlig");
  for (const [tag, value] of Object.entries(typography.featureSettings ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`font-feature = ${quoteGhosttyIdentifier(tag)} ${value}`);
  }
  for (const [axis, value] of Object.entries(typography.variableAxes ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    lines.push(`font-variation = ${quoteGhosttyIdentifier(axis)}=${value}`);
  }
  return lines;
}
function serializeFontSettings(settings: Readonly<Record<string, number>>): string {
  const entries = Object.entries(settings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length === 0
    ? "normal"
    : entries.map(([tag, value]) => `${quoteGhosttyIdentifier(tag)} ${value}`).join(", ");
}

function palette(variant: NormalizedAppearanceVariant): MobileRendererPalette {
  const terminal = variant.terminal;
  const terminalTypography = typographyRole(variant.typography.terminal);
  const ansi = Object.fromEntries(
    ANSI_ROLES.map((role) => [role, nativeColor(terminal.ansi[role])]),
  ) as AppearanceAnsi;
  const terminalTheme: MobileTerminalTheme = {
    background: nativeColor(terminal.background),
    foreground: nativeColor(terminal.foreground),
    cursor: nativeColor(terminal.cursor),
    selection: nativeColor(terminal.selection),
    scrollbar: nativeColor(terminal.scrollbar),
    scrollbarHover: nativeColor(terminal.scrollbarHover),
    ansi,
    palette: ANSI_ROLES.map((role) => ansi[role]),
    fontFamily: terminalTypography.family,
    fontSize: terminalTypography.sizePx,
    fontWeight: terminalTypography.weight,
    lineHeight: terminalTypography.lineHeight,
    letterSpacingEm: terminalTypography.letterSpacingEm,
    ligatures: terminalTypography.ligatures,
    featureSettings: terminalTypography.featureSettings,
    variableAxes: terminalTypography.variableAxes,
  };
  const diff = variant.diff;
  return {
    terminal: terminalTheme,
    review: Object.fromEntries(
      Object.entries(diff).map(([role, value]) => [role, nativeColor(value)]),
    ) as MobileRendererPalette["review"],
    preview: {
      canvas: nativeColor(variant.colors.canvas),
      accent: nativeColor(variant.colors.accent),
      messageAction: nativeColor(variant.colors.messageAction),
    },
  };
}

export function compileMobileAppearance(
  profile: NormalizedAppearanceProfile,
  appearance: "light" | "dark",
): MobileAppearanceOutput {
  const variant = variantForAppearance(profile, appearance);
  const colors = createMobileThemeVariables(variant.colors, appearance);
  const typography = typographyPreferences(variant);
  const c = variant.colors;
  const native = {
    navigation: {
      dark: appearance === "dark",
      primary: nativeColor(c.accent),
      background: nativeColor(c.canvas),
      card: nativeColor(c.chrome),
      text: nativeColor(c.text),
      border: nativeColor(c.toolbarBorder),
      notification: nativeColor(c.errorForeground),
      header: {
        background: nativeColor(c.toolbar),
        foreground: nativeColor(c.toolbarForeground),
        border: nativeColor(c.toolbarBorder),
      },
    },
    sheet: {
      background: nativeColor(c.chrome),
      foreground: nativeColor(c.text),
      border: nativeColor(c.border),
      handle: nativeColor(c.textMuted),
    },
    menu: {
      background: nativeColor(c.surfaceRaised),
      foreground: nativeColor(c.text),
      selected: nativeColor(c.sidebarRowSelected),
      border: nativeColor(c.border),
    },
    composer: {
      background: nativeColor(c.surfaceRaised),
      foreground: nativeColor(c.text),
      placeholder: nativeColor(c.placeholder),
      border: nativeColor(c.input),
      accent: nativeColor(c.accent),
    },
    editor: {
      background: nativeColor(c.codeBackground),
      foreground: nativeColor(c.codeForeground),
      selection: nativeColor(c.terminalSelection),
      font: typography.code,
    },
    filePreview: {
      background: nativeColor(c.canvas),
      foreground: nativeColor(c.text),
      tint: nativeColor(c.accent),
    },
    controls: {
      accent: nativeColor(c.accent),
      accentForeground: nativeColor(c.accentForeground),
      inactiveTrack: nativeColor(c.secondary),
      inactiveThumb: nativeColor(c.mutedForeground),
      danger: nativeColor(c.error),
      focus: nativeColor(c.focus),
    },
  } satisfies MobileNativeAppearance;
  const uniwindVariables: Record<string, string | number> = { ...colors };
  for (const role of TYPOGRAPHY_ROLES) {
    const value = typography[role];
    uniwindVariables[`--font-${role}`] = value.family;
    uniwindVariables[`--font-size-${role}`] = value.sizePx;
    uniwindVariables[`--font-weight-${role}`] = value.weight;
    uniwindVariables[`--line-height-${role}`] = value.lineHeight;
    uniwindVariables[`--letter-spacing-${role}`] = value.letterSpacingEm;
    uniwindVariables[`--font-variant-ligatures-${role}`] = value.ligatures ? "normal" : "none";
    uniwindVariables[`--font-feature-settings-${role}`] = serializeFontSettings(
      value.featureSettings,
    );
    uniwindVariables[`--font-variation-settings-${role}`] = serializeFontSettings(
      value.variableAxes,
    );
  }
  for (const [name, value] of Object.entries(variant.metrics.spacing))
    uniwindVariables[`--t3-space-${name}`] = value;
  for (const [name, value] of Object.entries(variant.metrics.radius))
    uniwindVariables[`--t3-radius-${name}`] = value;
  return {
    profileId: profile.metadata.id,
    variantId: variant.id,
    appearance,
    uniwindVariables,
    typographyPreferences: typography,
    rendererPalettes: palette(variant),
    native,
    unsupported: ["css", "package-fonts", "artwork-assets", "motion-effects"],
  };
}

export function buildMobileGhosttyConfig(theme: MobileTerminalTheme): string {
  const lines = [
    `background = ${theme.background}`,
    `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursor}`,
    `selection-background = ${theme.selection}`,
    ...buildGhosttyTypographyConfig(theme),
  ];
  for (const [index, color] of theme.palette.entries()) lines.push(`palette = ${index}=${color}`);
  return `${lines.join("\n")}\n`;
}
