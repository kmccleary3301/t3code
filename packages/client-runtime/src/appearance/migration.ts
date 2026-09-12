import * as Schema from "effect/Schema";

import {
  AppearanceColorValueSchema,
  AppearanceIdSchema,
  STRICT_APPEARANCE_PARSE_OPTIONS,
  appearanceSha256,
  type AppearanceDiagnostic,
  type AppearanceManifestV2,
  type AppearanceTrust,
  type NormalizedAppearanceProfile,
} from "@t3tools/shared/appearance";
import type { ThemeDefinition } from "@t3tools/shared/themePalettes";

import type {
  AppearanceCompilerAdapter,
  AppearancePersistedState,
  AppearancePreference,
  AppearanceStoredPackage,
} from "./model.ts";

const LegacyAppearancePreferenceSchema = Schema.Struct({
  mode: Schema.Literals(["system", "light", "dark"]),
  packageId: Schema.optionalKey(AppearanceIdSchema),
  lightPackageId: Schema.optionalKey(AppearanceIdSchema),
  darkPackageId: Schema.optionalKey(AppearanceIdSchema),
  variantId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  overrides: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(
        Schema.isPattern(/^(?:--[a-z][a-z0-9-]{0,126}|[a-z][A-Za-z0-9]{0,63})(?![\s\S])/u),
      ),
      AppearanceColorValueSchema,
    ),
  ),
});
const decodeLegacyPreference = Schema.decodeUnknownSync(LegacyAppearancePreferenceSchema);

function decodeLegacyAppearancePreference(input: unknown): AppearancePreference | null {
  try {
    return decodeLegacyPreference(input, STRICT_APPEARANCE_PARSE_OPTIONS);
  } catch {
    return null;
  }
}

export interface AppearanceLegacyInputAdapter {
  readonly read: () => Promise<ReadonlyArray<ThemeDefinition>>;
  readonly readPreference?: () => Promise<unknown | undefined>;
  readonly finalize?: () => Promise<void>;
}

export interface AppearanceMigrationOptions {
  readonly sourceTrust?: AppearanceTrust;
}

function toManifest(profile: NormalizedAppearanceProfile): AppearanceManifestV2 {
  return {
    schema: profile.schema,
    version: 2,
    metadata: profile.metadata,
    compatibility: profile.compatibility,
    capabilities: profile.requestedCapabilities,
    fallback: profile.fallback,
    defaultVariant: profile.defaultVariant,
    variants: profile.variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      appearance: variant.appearance,
      colors: variant.colors,
      typography: variant.typography,
      metrics: variant.metrics,
      motion: variant.motion,
      terminal: variant.terminal,
      syntax: variant.syntax,
      diff: variant.diff,
    })),
    assets: profile.assets,
    styles: profile.styles,
    presentation: profile.presentation,
  };
}

function storedPackage(profile: NormalizedAppearanceProfile): AppearanceStoredPackage {
  const manifest = toManifest(profile);
  return {
    manifest,
    profile,
    manifestHash: appearanceSha256(manifest),
    assets: [],
    diagnostics: [],
    enabled: true,
  };
}

/** Normalize legacy themes exactly once and merge them without replacing existing packages. */
export async function migrateAppearanceState(
  state: AppearancePersistedState,
  legacy: AppearanceLegacyInputAdapter,
  compiler: AppearanceCompilerAdapter,
  options: AppearanceMigrationOptions = {},
): Promise<AppearancePersistedState> {
  if (state.migration.completed) return state;

  const packages: Record<string, AppearanceStoredPackage> = { ...state.packages };
  const order = [...state.order];
  const diagnostics = [...state.diagnostics];
  let packageOverflowReported = false;
  const appendDiagnostic = (diagnostic: AppearanceDiagnostic): void => {
    if (diagnostics.length < 1_024) diagnostics.push(diagnostic);
  };
  const themes = await legacy.read();
  for (const theme of themes) {
    const result = compiler.normalize(theme, {
      sourceId: theme.id,
      ...(options.sourceTrust === undefined ? {} : { trust: options.sourceTrust }),
    });
    if (result.status === "failure") {
      appendDiagnostic(result.diagnostic);
      continue;
    }
    const id = result.profile.metadata.id;
    if (packages[id] !== undefined) continue;
    if (Object.keys(packages).length >= 256) {
      if (!packageOverflowReported) {
        packageOverflowReported = true;
        appendDiagnostic({
          code: "invalid-version-1-theme",
          severity: "warning",
          message: "Additional legacy themes were skipped because the package limit is 256.",
          path: ["themes"],
          recovery: "Export or remove unused legacy themes before importing additional packages.",
        });
      }
      continue;
    }
    packages[id] = storedPackage(result.profile);
    order.push(id);
  }
  const legacyPreference = await legacy.readPreference?.();
  let preference = state.preference;
  if (legacyPreference !== undefined) {
    const decodedPreference = decodeLegacyAppearancePreference(legacyPreference);
    if (decodedPreference === null) {
      appendDiagnostic({
        code: "invalid-version-1-theme",
        severity: "warning",
        message: "The legacy appearance preference is invalid and was ignored.",
        path: ["preference"],
        recovery: "Choose a supported appearance mode and package or variant selection.",
      });
    } else {
      preference = decodedPreference;
    }
  }

  return {
    ...state,
    revision: state.revision + 1,
    packages,
    order,
    preference,
    diagnostics,
    migration: { completed: true, sourceVersion: 1 },
  };
}
