import * as Schema from "effect/Schema";

import { compareSemverVersions } from "../semver.ts";
import {
  T3_CHAT_THEME,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "../themePalettes.ts";
import {
  APPEARANCE_MANIFEST_VERSION,
  APPEARANCE_SCHEMA_ID,
  AppearanceColorValueSchema,
  AppearanceColorsSchema,
  AppearanceCollectionIdSchema,
  AppearanceIdSchema,
  AppearanceManifestV2Schema,
  DEFAULT_APPEARANCE_COMPATIBILITY,
  DEFAULT_APPEARANCE_ARTWORK,
  DEFAULT_APPEARANCE_METRICS,
  DEFAULT_APPEARANCE_MOTION,
  DEFAULT_APPEARANCE_SYNTAX,
  DEFAULT_APPEARANCE_PRESENTATION,
  DEFAULT_APPEARANCE_TRUST,
  DEFAULT_APPEARANCE_TYPOGRAPHY,
  STRICT_APPEARANCE_PARSE_OPTIONS,
  defaultDiff,
  defaultTerminal,
  type AppearanceCapability,
  type AppearanceDiagnostic,
  type AppearanceManifestV2,
  type AppearanceMetrics,
  type AppearanceNormalizationResult,
  type AppearancePlatform,
  type AppearanceTrust,
  type AppearanceTypography,
  type AppearanceVariantManifest,
  type NormalizedAppearanceProfile,
  type NormalizedAppearanceVariant,
} from "./schema.ts";

const LegacyLabelSchema = Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(128));
const LegacyThemeCollectionSchema = Schema.Struct({
  id: AppearanceCollectionIdSchema,
  label: LegacyLabelSchema,
});
const LegacyThemeColorOverridesSchema = Schema.Struct(
  Object.fromEntries(
    THEME_COLOR_ROLES.map((role) => [role, Schema.optionalKey(AppearanceColorValueSchema)]),
  ),
).check(
  Schema.makeFilter(
    (colors) =>
      Object.keys(colors).length > 0 ||
      "A version 1 color override must declare at least one color role.",
  ),
);
const LegacyStoredThemeVariantsSchema = Schema.Struct({
  light: Schema.optionalKey(AppearanceColorsSchema),
  dark: Schema.optionalKey(AppearanceColorsSchema),
});
const LegacyThemeFileVariantsSchema = Schema.Struct({
  light: Schema.optionalKey(LegacyThemeColorOverridesSchema),
  dark: Schema.optionalKey(LegacyThemeColorOverridesSchema),
});
const LegacyThemeDefinitionSchema = Schema.Struct({
  id: AppearanceIdSchema,
  label: LegacyLabelSchema,
  appearance: Schema.Literals(["light", "dark"]),
  colors: AppearanceColorsSchema,
  variants: Schema.optionalKey(LegacyStoredThemeVariantsSchema),
  collection: Schema.optionalKey(LegacyThemeCollectionSchema),
  sidebarArtwork: Schema.optionalKey(Schema.Boolean),
  managed: Schema.optionalKey(Schema.Boolean),
});

const ThemeFileV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.optionalKey(AppearanceIdSchema),
  name: LegacyLabelSchema,
  appearance: Schema.Literals(["light", "dark"]),
  colors: LegacyThemeColorOverridesSchema,
  variants: Schema.optionalKey(LegacyThemeFileVariantsSchema),
  collection: Schema.optionalKey(LegacyThemeCollectionSchema),
  managed: Schema.optionalKey(Schema.Boolean),
});
type LegacyThemeDefinition = typeof LegacyThemeDefinitionSchema.Type;
type ThemeFileV1 = typeof ThemeFileV1Schema.Type;

export interface AppearanceNormalizationOptions {
  readonly sourceId?: string;
  readonly trust?: AppearanceTrust;
  readonly appVersion?: string;
  readonly platform?: AppearancePlatform;
  readonly supportedCapabilities?: ReadonlySet<AppearanceCapability>;
}

function diagnostic(
  code: AppearanceDiagnostic["code"],
  message: string,
  recovery: string,
  path: AppearanceDiagnostic["path"] = [],
): AppearanceNormalizationResult {
  return {
    status: "failure",
    diagnostic: { code, severity: "error", message, path, recovery },
  };
}

function asRecord(input: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return input as Readonly<Record<string, unknown>>;
}

function decodeStrict<SchemaType extends Schema.Top>(
  schema: SchemaType,
  input: unknown,
): SchemaType["Type"] | null {
  try {
    return Schema.decodeUnknownSync(schema as never)(
      input,
      STRICT_APPEARANCE_PARSE_OPTIONS,
    ) as SchemaType["Type"];
  } catch {
    return null;
  }
}
function normalizeTypography(typography: AppearanceTypography | undefined): AppearanceTypography {
  const source = typography ?? DEFAULT_APPEARANCE_TYPOGRAPHY;
  const withDefaults = (role: keyof AppearanceTypography) => ({
    ...DEFAULT_APPEARANCE_TYPOGRAPHY[role],
    ...source[role],
    featureSettings: source[role].featureSettings ?? {},
  });
  return {
    interface: withDefaults("interface"),
    composer: withDefaults("composer"),
    code: withDefaults("code"),
    terminal: withDefaults("terminal"),
    markdown: withDefaults("markdown"),
    label: withDefaults("label"),
    heading: withDefaults("heading"),
  };
}

function immutable<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}
const RECOVERY_SIZING_BOUNDS = {
  sidebar: { minimum: 160, maximum: 1024 },
  composer: { minimum: 160, maximum: 1600 },
  terminal: { minimum: 80, maximum: 1600 },
  tab: { minimum: 24, maximum: 128 },
  panel: { minimum: 160, maximum: 2000 },
} as const;

function normalizeMetrics(metrics: AppearanceMetrics | undefined): AppearanceMetrics {
  const source = metrics ?? DEFAULT_APPEARANCE_METRICS;
  const clampRange = <Role extends keyof AppearanceMetrics["sizing"]>(role: Role) => {
    const range = source.sizing[role];
    const bounds = RECOVERY_SIZING_BOUNDS[role];
    const minimum = Math.max(bounds.minimum, Math.min(bounds.maximum, range.minimumPx));
    const preferred = Math.max(minimum, Math.min(bounds.maximum, range.preferredPx));
    const maximum = Math.max(preferred, Math.min(4096, Math.max(bounds.minimum, range.maximumPx)));
    return { minimumPx: minimum, preferredPx: preferred, maximumPx: maximum };
  };
  return {
    ...DEFAULT_APPEARANCE_METRICS,
    ...source,
    ...((source.outline ?? DEFAULT_APPEARANCE_METRICS.outline) === undefined
      ? {}
      : { outline: source.outline ?? DEFAULT_APPEARANCE_METRICS.outline }),
    ...((source.elevation ?? DEFAULT_APPEARANCE_METRICS.elevation) === undefined
      ? {}
      : { elevation: source.elevation ?? DEFAULT_APPEARANCE_METRICS.elevation }),
    sizing: {
      sidebar: clampRange("sidebar"),
      composer: clampRange("composer"),
      terminal: clampRange("terminal"),
      tab: clampRange("tab"),
      panel: clampRange("panel"),
    },
  };
}

function normalizeVariant(variant: AppearanceVariantManifest): NormalizedAppearanceVariant {
  return {
    id: variant.id,
    label: variant.label,
    appearance: variant.appearance,
    colors: variant.colors,
    typography: normalizeTypography(variant.typography),
    metrics: normalizeMetrics(variant.metrics),
    motion: variant.motion ?? DEFAULT_APPEARANCE_MOTION,
    artwork: variant.artwork ?? DEFAULT_APPEARANCE_ARTWORK,
    terminal: variant.terminal ?? defaultTerminal(variant.colors),
    syntax: variant.syntax ?? DEFAULT_APPEARANCE_SYNTAX,
    diff: variant.diff ?? defaultDiff(variant.colors),
  };
}
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function firstDuplicate(values: ReadonlyArray<string>): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function validateManifestIdentity(
  manifest: AppearanceManifestV2,
): AppearanceNormalizationResult | null {
  const duplicateCapability = firstDuplicate(manifest.capabilities);
  const duplicateRequiredCapability = firstDuplicate(manifest.compatibility.requiredCapabilities);
  const duplicatePlatform = firstDuplicate(manifest.compatibility.platforms);
  if (
    duplicateCapability !== null ||
    duplicateRequiredCapability !== null ||
    duplicatePlatform !== null
  ) {
    return diagnostic(
      "invalid-manifest",
      "Appearance capability and platform declarations must not contain duplicates.",
      "Remove duplicate set entries.",
      ["compatibility"],
    );
  }
  const undeclaredRequirement = manifest.compatibility.requiredCapabilities.find(
    (capability) => !manifest.capabilities.includes(capability),
  );
  if (undeclaredRequirement !== undefined) {
    return diagnostic(
      "invalid-manifest",
      `Required capability '${undeclaredRequirement}' is not declared by the package.`,
      "Add it to capabilities or remove it from requiredCapabilities.",
      ["compatibility", "requiredCapabilities"],
    );
  }
  const styleCapabilities = [
    {
      capability: "shared-css" as const,
      entrypoint: manifest.styles?.web,
      path: "web",
    },
    {
      capability: "desktop-css" as const,
      entrypoint: manifest.styles?.desktop,
      path: "desktop",
    },
  ];
  for (const style of styleCapabilities) {
    if (manifest.capabilities.includes(style.capability) !== (style.entrypoint !== undefined)) {
      return diagnostic(
        "invalid-manifest",
        `Appearance style '${style.path}' and capability '${style.capability}' must be declared together.`,
        "Declare both the CSS capability and its bounded stylesheet entrypoint, or remove both.",
        ["styles", style.path],
      );
    }
    if (style.entrypoint !== undefined && style.entrypoint.path.split("/").length > 8) {
      return diagnostic(
        "invalid-manifest",
        `Appearance stylesheet '${style.entrypoint.path}' exceeds the eight-segment path limit.`,
        "Move the stylesheet to a shallower package path.",
        ["styles", style.path, "path"],
      );
    }
  }
  const variantIds = new Set<string>();
  for (let index = 0; index < manifest.variants.length; index += 1) {
    const id = manifest.variants[index]?.id;
    if (id === undefined) continue;
    if (variantIds.has(id)) {
      return diagnostic(
        "duplicate-variant",
        `Appearance variant '${id}' is declared more than once.`,
        "Give every variant a unique id.",
        ["variants", index, "id"],
      );
    }
    variantIds.add(id);
    const variant = manifest.variants[index];
    if (variant?.metrics !== undefined) {
      for (const [role, range] of Object.entries(variant.metrics.sizing)) {
        if (range.minimumPx > range.preferredPx || range.preferredPx > range.maximumPx) {
          return diagnostic(
            "invalid-manifest",
            `Appearance sizing role '${role}' must order minimum, preferred, and maximum values.`,
            "Set minimumPx <= preferredPx <= maximumPx.",
            ["variants", index, "metrics", "sizing", role],
          );
        }
      }
    }
    if (variant?.motion !== undefined) {
      const { instant, fast, normal, slow } = variant.motion.durationsMs;
      if (instant > fast || fast > normal || normal > slow) {
        return diagnostic(
          "invalid-manifest",
          "Appearance motion durations must increase from instant through slow.",
          "Set instant <= fast <= normal <= slow.",
          ["variants", index, "motion", "durationsMs"],
        );
      }
    }
  }
  if (!variantIds.has(manifest.defaultVariant)) {
    return diagnostic(
      "missing-default-variant",
      `Default appearance variant '${manifest.defaultVariant}' is not declared.`,
      "Set defaultVariant to one of the declared variant ids.",
      ["defaultVariant"],
    );
  }

  const assetIds = new Set<string>();
  for (let index = 0; index < manifest.assets.length; index += 1) {
    const asset = manifest.assets[index];
    if (asset === undefined) continue;
    if (assetIds.has(asset.id)) {
      return diagnostic(
        "duplicate-asset",
        `Appearance asset '${asset.id}' is declared more than once.`,
        "Give every asset a unique id.",
        ["assets", index, "id"],
      );
    }
    assetIds.add(asset.id);
    if (firstDuplicate(asset.platforms) !== null) {
      return diagnostic(
        "invalid-manifest",
        `Appearance asset '${asset.id}' repeats a target platform.`,
        "List each target platform once.",
        ["assets", index, "platforms"],
      );
    }
    if (asset.path.split("/").length > 8) {
      return diagnostic(
        "invalid-manifest",
        `Appearance asset '${asset.id}' exceeds the eight-segment path limit.`,
        "Move the asset to a shallower package path.",
        ["assets", index, "path"],
      );
    }
    const fontValid =
      asset.kind === "font" && asset.mimeType === "font/woff2" && asset.family !== undefined;
    const imageValid =
      asset.kind === "image" &&
      asset.mimeType.startsWith("image/") &&
      asset.family === undefined &&
      asset.style === undefined &&
      asset.weight === undefined;
    if (!fontValid && !imageValid) {
      return diagnostic(
        "invalid-manifest",
        `Appearance asset '${asset.id}' has inconsistent kind, MIME type, or font metadata.`,
        "Use font/woff2 with a family for fonts, or an image MIME type for images.",
        ["assets", index],
      );
    }
  }
  const imageAssetIds = new Set(
    manifest.assets.filter((asset) => asset.kind === "image").map((asset) => asset.id),
  );
  for (let index = 0; index < manifest.variants.length; index += 1) {
    const artwork = manifest.variants[index]?.artwork;
    if (artwork === undefined) continue;
    for (const [role, assetId] of Object.entries(artwork)) {
      if (role === "selection" || role === "scrollbar" || role === "scrollbarHover") continue;
      if (assetId !== undefined && !imageAssetIds.has(assetId)) {
        return diagnostic(
          "invalid-manifest",
          `Artwork role '${role}' references a missing image asset.`,
          "Declare the referenced local image asset or remove the artwork role.",
          ["variants", index, "artwork", role],
        );
      }
    }
  }
  return null;
}

function validateCompatibility(
  profile: NormalizedAppearanceProfile,
  options: AppearanceNormalizationOptions,
): AppearanceNormalizationResult | null {
  const { compatibility } = profile;
  if (
    compatibility.minimumAppVersion !== undefined &&
    compatibility.maximumAppVersion !== undefined &&
    compareSemverVersions(compatibility.minimumAppVersion, compatibility.maximumAppVersion) > 0
  ) {
    return diagnostic(
      "invalid-manifest",
      "Appearance minimum app version exceeds its maximum app version.",
      "Order compatibility bounds from minimum to maximum.",
      ["compatibility"],
    );
  }
  if (
    options.appVersion !== undefined &&
    compatibility.minimumAppVersion !== undefined &&
    compareSemverVersions(options.appVersion, compatibility.minimumAppVersion) < 0
  ) {
    return diagnostic(
      "incompatible-app-version",
      `Appearance package requires app version ${compatibility.minimumAppVersion} or newer.`,
      "Upgrade the app or install a compatible appearance package version.",
      ["compatibility", "minimumAppVersion"],
    );
  }
  if (
    options.appVersion !== undefined &&
    compatibility.maximumAppVersion !== undefined &&
    compareSemverVersions(options.appVersion, compatibility.maximumAppVersion) > 0
  ) {
    return diagnostic(
      "incompatible-app-version",
      `Appearance package supports app version ${compatibility.maximumAppVersion} or older.`,
      "Install a newer appearance package version.",
      ["compatibility", "maximumAppVersion"],
    );
  }
  if (options.platform !== undefined && !compatibility.platforms.includes(options.platform)) {
    return diagnostic(
      "unsupported-platform",
      `Appearance package does not support platform '${options.platform}'.`,
      "Use the package on a declared platform.",
      ["compatibility", "platforms"],
    );
  }
  if (options.supportedCapabilities !== undefined) {
    const missing = compatibility.requiredCapabilities.find(
      (capability) => !options.supportedCapabilities?.has(capability),
    );
    if (missing !== undefined) {
      return diagnostic(
        "unsupported-capability",
        `Appearance package requires unsupported capability '${missing}'.`,
        "Use a client that advertises the required capability.",
        ["compatibility", "requiredCapabilities"],
      );
    }
  }
  return null;
}
function validateTrust(
  manifest: AppearanceManifestV2,
  trust: AppearanceTrust,
): AppearanceNormalizationResult | null {
  if (manifest.capabilities.includes("shared-css") && !trust.allowSharedCss) {
    return diagnostic(
      "unsupported-capability",
      "Appearance package requests shared CSS without a shared-CSS trust grant.",
      "Install with an explicit shared-CSS grant or remove the capability.",
      ["capabilities"],
    );
  }
  if (manifest.capabilities.includes("desktop-css") && !trust.allowDesktopCss) {
    return diagnostic(
      "unsupported-capability",
      "Appearance package requests desktop CSS without a desktop-CSS trust grant.",
      "Install with an explicit desktop-CSS grant or remove the capability.",
      ["capabilities"],
    );
  }
  if (
    trust.class === "local-snippet" ||
    (trust.class === "environment-palette" &&
      (trust.allowSharedCss || trust.allowDesktopCss || trust.allowAdvancedSnippet)) ||
    (trust.class === "local-package" && trust.allowAdvancedSnippet) ||
    (trust.class === "builtin" && trust.allowAdvancedSnippet)
  ) {
    return diagnostic(
      "unsupported-capability",
      "Appearance trust class and executable grants are inconsistent.",
      "Derive trust from builtin, local-package, environment-palette, or reviewed installation boundaries.",
      ["trust"],
    );
  }
  return null;
}

function normalizeV2(
  manifest: AppearanceManifestV2,
  options: AppearanceNormalizationOptions,
): AppearanceNormalizationResult {
  const identityFailure = validateManifestIdentity(manifest);
  if (identityFailure !== null) return identityFailure;
  const trust = options.trust ?? DEFAULT_APPEARANCE_TRUST;
  const trustFailure = validateTrust(manifest, trust);
  if (trustFailure !== null) return trustFailure;

  const requestedCapabilities = [...manifest.capabilities].sort(compareCodeUnits);
  const capabilities = requestedCapabilities.filter(
    (capability) =>
      (capability !== "shared-css" || trust.allowSharedCss) &&
      (capability !== "desktop-css" || trust.allowDesktopCss),
  );
  const profile: NormalizedAppearanceProfile = {
    schema: APPEARANCE_SCHEMA_ID,
    metadata: manifest.metadata,
    compatibility: {
      ...manifest.compatibility,
      platforms: [...manifest.compatibility.platforms].sort(compareCodeUnits),
      requiredCapabilities: [...manifest.compatibility.requiredCapabilities].sort(compareCodeUnits),
    },
    requestedCapabilities,
    capabilities,
    trust,
    fallback: manifest.fallback,
    defaultVariant: manifest.defaultVariant,
    variants: manifest.variants.map(normalizeVariant),
    assets: [...manifest.assets]
      .filter(
        (asset) => options.platform === undefined || asset.platforms.includes(options.platform),
      )
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
    styles: manifest.styles ?? {},
    presentation: manifest.presentation ?? DEFAULT_APPEARANCE_PRESENTATION,
    migration: { sourceVersion: 2, targetVersion: 2, migrated: false, notes: [] },
  };
  return (
    validateCompatibility(profile, options) ?? {
      status: "success",
      profile: immutable(profile),
    }
  );
}

function legacyVariant(
  appearance: ThemeAppearance,
  colors: LegacyThemeDefinition["colors"],
  label: string,
): AppearanceVariantManifest {
  return { id: appearance, label, appearance, colors };
}

function legacyVariants(
  appearance: ThemeAppearance,
  colors: LegacyThemeDefinition["colors"],
  variants: ThemeVariants | undefined,
  label: string,
): ReadonlyArray<AppearanceVariantManifest> {
  const normalized: AppearanceVariantManifest[] = [legacyVariant(appearance, colors, label)];
  for (const candidate of ["light", "dark"] as const) {
    const candidateColors = variants?.[candidate];
    if (candidate !== appearance && candidateColors !== undefined) {
      normalized.push(
        legacyVariant(
          candidate,
          candidateColors,
          `${label} ${candidate === "light" ? "Light" : "Dark"}`,
        ),
      );
    }
  }
  return normalized;
}

function normalizeLegacyTheme(
  theme: LegacyThemeDefinition,
  options: AppearanceNormalizationOptions,
): AppearanceNormalizationResult {
  const candidate = {
    schema: APPEARANCE_SCHEMA_ID,
    version: APPEARANCE_MANIFEST_VERSION,
    metadata: { id: theme.id, name: theme.label, version: "1.0.0" },
    compatibility: DEFAULT_APPEARANCE_COMPATIBILITY,
    capabilities: ["colors"],
    fallback: { light: "default-variant", dark: "default-variant" },
    defaultVariant: theme.appearance,
    variants: legacyVariants(theme.appearance, theme.colors, theme.variants, theme.label),
    assets: [],
    styles: {},
    presentation: {
      sidebarArtwork: theme.sidebarArtwork ?? false,
      managed: theme.managed ?? false,
      ...(theme.collection === undefined ? {} : { collection: theme.collection }),
    },
  };
  const manifest = decodeStrict(AppearanceManifestV2Schema, candidate);
  if (manifest === null) {
    return diagnostic(
      "invalid-version-1-theme",
      "Version 1 theme metadata cannot be represented by the strict version 2 contract.",
      "Use a strict package id, bounded display labels, and valid collection metadata.",
    );
  }
  const result = normalizeV2(manifest, options);
  if (result.status === "failure") return result;
  return {
    status: "success",
    profile: immutable({
      ...result.profile,
      migration: {
        sourceVersion: 1,
        targetVersion: 2,
        migrated: true,
        notes: ["Normalized a version 1 theme without changing any color role value."],
      },
    }),
  };
}

function defaultLegacyColors(appearance: ThemeAppearance): ThemeColors {
  const colors = appearance === "dark" ? T3_CHAT_THEME.variants?.dark : T3_CHAT_THEME.colors;
  if (colors === undefined) throw new Error("T3 Chat dark fallback colors are unavailable.");
  return colors;
}

function fillLegacyColorOverrides(
  appearance: ThemeAppearance,
  overrides: Partial<ThemeColors>,
): ThemeColors {
  return { ...defaultLegacyColors(appearance), ...overrides };
}

function themeFileToLegacy(
  file: ThemeFileV1,
  sourceId: string | undefined,
): LegacyThemeDefinition | null {
  const id = file.id ?? sourceId;
  if (id === undefined || file.variants?.[file.appearance] !== undefined) return null;
  const variants: ThemeVariants = {
    ...(file.variants?.light === undefined
      ? {}
      : { light: fillLegacyColorOverrides("light", file.variants.light) }),
    ...(file.variants?.dark === undefined
      ? {}
      : { dark: fillLegacyColorOverrides("dark", file.variants.dark) }),
  };
  return {
    id,
    label: file.name,
    appearance: file.appearance,
    colors: fillLegacyColorOverrides(file.appearance, file.colors),
    ...(Object.keys(variants).length === 0 ? {} : { variants }),
    ...(file.collection === undefined ? {} : { collection: file.collection }),
    ...(file.managed === undefined ? {} : { managed: file.managed }),
  };
}

export function normalizeAppearance(
  input: unknown,
  options: AppearanceNormalizationOptions = {},
): AppearanceNormalizationResult {
  const record = asRecord(input);
  if (record === null) {
    return diagnostic(
      "invalid-manifest",
      "Appearance input must be an object.",
      "Provide a version 2 manifest or a version 1 theme object.",
    );
  }

  if (record.version === APPEARANCE_MANIFEST_VERSION || record.schema === APPEARANCE_SCHEMA_ID) {
    const manifest = decodeStrict(AppearanceManifestV2Schema, input);
    if (manifest === null) {
      return diagnostic(
        "invalid-manifest",
        "Appearance manifest does not match the strict version 2 schema.",
        "Remove unknown fields and correct the reported package structure.",
      );
    }
    return normalizeV2(manifest, options);
  }

  if (record.version === 1) {
    const file = decodeStrict(ThemeFileV1Schema, input);
    if (file === null) {
      return diagnostic(
        "invalid-version-1-theme",
        "Version 1 theme does not match the supported exported-theme shape.",
        "Provide complete role colors and only version 1 theme fields.",
      );
    }
    const legacy = themeFileToLegacy(file, options.sourceId);
    if (legacy === null) {
      return diagnostic(
        "invalid-version-1-theme",
        "Version 1 theme has no stable id.",
        "Provide id in the theme or sourceId in normalization options.",
        ["id"],
      );
    }
    return normalizeLegacyTheme(legacy, options);
  }

  if (typeof record.version === "number") {
    return diagnostic(
      "unsupported-version",
      `Appearance manifest version ${record.version} is not supported.`,
      `Use manifest version ${APPEARANCE_MANIFEST_VERSION}.`,
      ["version"],
    );
  }

  const legacy = decodeStrict(LegacyThemeDefinitionSchema, input);
  if (legacy === null) {
    return diagnostic(
      "invalid-version-1-theme",
      "Stored theme does not match the supported version 1 theme definition.",
      "Provide a complete stored ThemeDefinition or migrate to a version 2 manifest.",
    );
  }
  return normalizeLegacyTheme(legacy, options);
}

export function normalizeThemeDefinition(
  theme: ThemeDefinition,
  options: AppearanceNormalizationOptions = {},
): NormalizedAppearanceProfile {
  const result = normalizeAppearance(theme, options);
  if (result.status === "failure") {
    throw new Error(`Built-in ThemeDefinition failed normalization: ${result.diagnostic.code}`);
  }
  return result.profile;
}
