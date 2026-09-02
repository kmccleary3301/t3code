import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BUILT_IN_THEMES, T3_CHAT_THEME, type ThemeDefinition } from "../themePalettes.ts";
import {
  appearanceSha256,
  canonicalAppearanceJson,
  hashNormalizedAppearanceProfile,
} from "./canonical.ts";
import { normalizeAppearance, normalizeThemeDefinition } from "./normalize.ts";
import {
  APPEARANCE_MANIFEST_VERSION,
  APPEARANCE_SCHEMA_ID,
  APPEARANCE_TYPOGRAPHY_ROLES,
  DEFAULT_APPEARANCE_METRICS,
  DEFAULT_APPEARANCE_MOTION,
  DEFAULT_APPEARANCE_TYPOGRAPHY,
  AppearanceDiagnosticSchema,
  AppearanceStyleEntrypointSchema,
  NormalizedAppearanceProfileSchema,
  STRICT_APPEARANCE_PARSE_OPTIONS,
  type AppearanceManifestV2,
} from "./schema.ts";
const decodeAppearanceDiagnostic = Schema.decodeUnknownSync(AppearanceDiagnosticSchema);
const decodeAppearanceStyleEntrypoint = Schema.decodeUnknownSync(AppearanceStyleEntrypointSchema);
const decodeNormalizedAppearanceProfile = Schema.decodeUnknownSync(
  NormalizedAppearanceProfileSchema,
);

function requireSuccess(input: unknown) {
  const result = normalizeAppearance(input);
  if (result.status === "failure") {
    assert.fail(`Expected normalized appearance, got ${result.diagnostic.code}`);
  }
  return result.profile;
}

function manifestV2(): AppearanceManifestV2 {
  const profile = normalizeThemeDefinition(T3_CHAT_THEME);
  return {
    schema: APPEARANCE_SCHEMA_ID,
    version: APPEARANCE_MANIFEST_VERSION,
    metadata: { id: "test-package", name: "Test Package", version: "2.3.4" },
    compatibility: {
      minimumAppVersion: "1.2.0",
      maximumAppVersion: "3.0.0",
      platforms: ["web", "desktop-macos"],
      requiredCapabilities: ["colors", "typography"],
    },
    capabilities: [
      "colors",
      "typography",
      "layout-metrics",
      "motion",
      "terminal",
      "syntax",
      "diff",
      "images",
      "fonts",
    ],
    fallback: { light: "default-variant", dark: "default-variant" },
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
    assets: [
      {
        id: "brand-image",
        kind: "image",
        path: "assets/brand.webp",
        sha256: "a".repeat(64),
        mimeType: "image/webp",
        sizeBytes: 1024,
        platforms: ["web", "desktop-macos"],
      },
      {
        id: "interface-font",
        kind: "font",
        path: "assets/interface.woff2",
        sha256: "b".repeat(64),
        mimeType: "font/woff2",
        sizeBytes: 4096,
        platforms: ["web"],
        family: "Appearance Sans",
        style: "normal",
        weight: 400,
      },
    ],
  };
}

function findVariant(theme: ThemeDefinition, appearance: "light" | "dark") {
  if (theme.appearance === appearance) return theme.colors;
  return theme.variants?.[appearance];
}

describe("appearance stylesheet schema", () => {
  it("accepts only contained CSS entrypoints", () => {
    const entrypoint = {
      path: "styles/Theme.CSS",
      sha256: "a".repeat(64),
      sizeBytes: 128,
    };
    assert.doesNotThrow(() =>
      decodeAppearanceStyleEntrypoint(entrypoint, STRICT_APPEARANCE_PARSE_OPTIONS),
    );
    assert.throws(() =>
      decodeAppearanceStyleEntrypoint(
        { ...entrypoint, path: "styles/theme.js" },
        STRICT_APPEARANCE_PARSE_OPTIONS,
      ),
    );
  });
});

describe("normalized appearance contract", () => {
  it("filters assets that do not target the normalized platform", () => {
    const manifest = manifestV2();
    const image = manifest.assets[0];
    if (image === undefined) assert.fail("Expected an image fixture.");
    const result = normalizeAppearance(
      {
        ...manifest,
        assets: [
          ...manifest.assets,
          { ...image, id: "desktop-only", platforms: ["desktop-macos"] },
        ],
      },
      { platform: "web" },
    );
    assert.equal(result.status, "success");
    if (result.status === "success") {
      assert.deepStrictEqual(
        result.profile.assets.map((asset) => asset.id),
        ["brand-image", "interface-font"],
      );
    }
  });
  it("normalizes every built-in without changing any palette byte", () => {
    for (const theme of BUILT_IN_THEMES) {
      const profile = normalizeThemeDefinition(theme, {
        trust: {
          class: "builtin",
          allowSharedCss: false,
          allowDesktopCss: false,
          allowAdvancedSnippet: false,
        },
      });
      assert.equal(profile.metadata.id, theme.id);
      assert.equal(profile.defaultVariant, theme.appearance);
      assert.equal(profile.trust.class, "builtin");
      assert.equal(profile.presentation.sidebarArtwork, theme.sidebarArtwork ?? false);
      assert.equal(profile.presentation.managed, theme.managed ?? false);
      assert.deepStrictEqual(
        profile.presentation.collection,
        theme.collection ? { id: theme.collection.id, label: theme.collection.label } : undefined,
      );
      for (const appearance of ["light", "dark"] as const) {
        const original = findVariant(theme, appearance);
        const normalized = profile.variants.find((variant) => variant.appearance === appearance);
        if (original === undefined) {
          assert.isUndefined(normalized);
        } else {
          assert.deepStrictEqual(normalized?.colors, original);
        }
      }
    }
  });

  it("normalizes stored and exported version 1 themes with migration metadata", () => {
    const stored = requireSuccess(T3_CHAT_THEME);
    assert.deepStrictEqual(stored.variants[0]?.colors, T3_CHAT_THEME.colors);
    assert.deepStrictEqual(stored.migration, {
      sourceVersion: 1,
      targetVersion: 2,
      migrated: true,
      notes: ["Normalized a version 1 theme without changing any color role value."],
    });

    const exported = {
      version: 1 as const,
      name: "Exported",
      appearance: T3_CHAT_THEME.appearance,
      colors: T3_CHAT_THEME.colors,
      variants: T3_CHAT_THEME.variants,
    };
    const missingId = normalizeAppearance(exported);
    assert.equal(
      normalizeAppearance({ ...exported, colors: {} }, { sourceId: "empty-colors" }).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance(
        { ...exported, colors: { accent: "#fff" }, variants: { dark: {} } },
        { sourceId: "empty-variant" },
      ).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance(
        { ...exported, colors: { accent: "#fff" }, variants: { light: { canvas: "#000" } } },
        { sourceId: "repeated-base-variant" },
      ).status,
      "failure",
    );
    assert.equal(missingId.status, "failure");
    if (missingId.status === "failure") {
      assert.equal(missingId.diagnostic.code, "invalid-version-1-theme");
    }
    const withSourceId = normalizeAppearance(exported, { sourceId: "exported" });
    assert.equal(withSourceId.status, "success");
    const partial = normalizeAppearance({
      version: 1,
      id: "partial-export",
      name: "Partial Export",
      appearance: "light",
      colors: { accent: "rgb(1 2 3)" },
      variants: { dark: { accent: "rgb(4 5 6)" } },
      collection: { id: "open-vsx:demo.theme", label: "Open VSX" },
      managed: true,
    });
    assert.equal(partial.status, "success");
    if (partial.status === "success") {
      assert.equal(partial.profile.variants[0]?.colors.accent, "rgb(1 2 3)");
      assert.equal(partial.profile.variants[0]?.colors.canvas, T3_CHAT_THEME.colors.canvas);
      assert.equal(
        partial.profile.variants.find((variant) => variant.appearance === "dark")?.colors.accent,
        "rgb(4 5 6)",
      );
      assert.deepStrictEqual(partial.profile.presentation.collection, {
        id: "open-vsx:demo.theme",
        label: "Open VSX",
      });
      assert.isTrue(partial.profile.presentation.managed);
    }
    if (withSourceId.status === "success") {
      assert.equal(withSourceId.profile.metadata.id, "exported");
      assert.deepStrictEqual(withSourceId.profile.variants[0]?.colors, T3_CHAT_THEME.colors);
    }
  });

  it("decodes complete version 2 semantics and bounded assets", () => {
    const manifest = manifestV2();
    const profile = requireSuccess(manifest);
    const first = profile.variants[0];
    assert.exists(first);
    assert.deepStrictEqual(
      Object.keys(first.typography).sort(),
      [...APPEARANCE_TYPOGRAPHY_ROLES].sort(),
    );
    assert.deepStrictEqual(first.metrics, manifest.variants[0]?.metrics);
    assert.deepStrictEqual(first.motion, manifest.variants[0]?.motion);
    assert.equal(profile.assets.length, 2);
    assert.equal(profile.migration.migrated, false);
  });

  it("fills every normalized semantic section when version 2 omits optional sections", () => {
    const manifest = manifestV2();
    const variant = manifest.variants[0];
    assert.exists(variant);
    const profile = requireSuccess({
      ...manifest,
      variants: [
        {
          id: variant.id,
          label: variant.label,
          appearance: variant.appearance,
          colors: variant.colors,
        },
      ],
      defaultVariant: variant.id,
      assets: [],
    });
    assert.deepStrictEqual(profile.variants[0]?.typography, DEFAULT_APPEARANCE_TYPOGRAPHY);
    assert.deepStrictEqual(profile.variants[0]?.metrics, DEFAULT_APPEARANCE_METRICS);
    assert.deepStrictEqual(profile.variants[0]?.motion, DEFAULT_APPEARANCE_MOTION);
    assert.equal(profile.variants[0]?.terminal.background, variant.colors.terminalBackground);
    assert.equal(profile.variants[0]?.diff.deletionBackground, variant.colors.errorSurface);
  });
  it("keeps shared defaults immutable across normalized profiles", () => {
    const manifest = manifestV2();
    const variant = manifest.variants[0];
    if (variant === undefined) assert.fail("Fixture is incomplete.");
    const minimal = {
      ...manifest,
      variants: [
        {
          id: variant.id,
          label: variant.label,
          appearance: variant.appearance,
          colors: variant.colors,
        },
      ],
      defaultVariant: variant.id,
      assets: [],
    };
    const first = requireSuccess(minimal);
    const firstTypography = first.variants[0]?.typography.interface;
    if (firstTypography === undefined) assert.fail("Normalized typography is missing.");
    assert.isFalse(Reflect.set(firstTypography, "sizePx", 99));
    assert.equal(requireSuccess(minimal).variants[0]?.typography.interface.sizePx, 16);
  });

  it("rejects unknown, malformed, future, and internally inconsistent inputs", () => {
    const manifest = manifestV2();
    assert.equal(normalizeAppearance({ ...manifest, unexpected: true }).status, "failure");
    assert.equal(
      normalizeAppearance({ ...manifest, metadata: { ...manifest.metadata, unexpected: true } })
        .status,
      "failure",
    );
    const firstVariant = manifest.variants[0];
    if (firstVariant === undefined) assert.fail("Fixture is incomplete.");
    assert.equal(
      normalizeAppearance({
        ...manifest,
        variants: [{ ...firstVariant, colors: {} }],
      }).status,
      "failure",
    );
    for (const malformed of [
      { ...manifest, metadata: { ...manifest.metadata, id: `${manifest.metadata.id}\n` } },
      {
        ...manifest,
        metadata: { ...manifest.metadata, version: `${manifest.metadata.version}\n` },
      },
      {
        ...manifest,
        variants: [{ ...firstVariant, id: `${firstVariant.id}\n` }],
      },
      {
        ...manifest,
        assets: [{ ...manifest.assets[0]!, sha256: `${manifest.assets[0]!.sha256}\n` }],
      },
      {
        ...manifest,
        assets: [{ ...manifest.assets[0]!, path: `${manifest.assets[0]!.path}\n` }],
      },
      {
        ...manifest,
        variants: [
          {
            ...firstVariant,
            colors: {
              ...firstVariant.colors,
              canvas: "red;--remote:url(https://example.invalid)",
            },
          },
        ],
      },
    ]) {
      assert.equal(
        normalizeAppearance(malformed).status,
        "failure",
        JSON.stringify(malformed).slice(0, 200),
      );
    }
    const variant = manifest.variants[0];
    if (variant?.typography === undefined) assert.fail("Fixture is incomplete.");
    assert.equal(
      normalizeAppearance({
        ...manifest,
        variants: [
          {
            ...variant,
            typography: {
              ...variant.typography,
              interface: { ...variant.typography.interface, unknownRoleValue: true },
            },
          },
        ],
      }).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance({
        ...manifest,
        variants: [
          {
            ...variant,
            typography: {
              ...variant.typography,
              interface: {
                ...variant.typography.interface,
                variableAxes: { "wght\n": 400 },
              },
            },
          },
        ],
      }).status,
      "failure",
    );
    for (const version of ["1.0", "01.0.0", "1.0.0-01", " 1.0.0", "9007199254740992.0.0"]) {
      assert.equal(
        normalizeAppearance({
          ...manifest,
          metadata: { ...manifest.metadata, version },
        }).status,
        "failure",
      );
    }
    assert.equal(normalizeAppearance({ ...manifest, version: 99 }).status, "failure");
    assert.equal(normalizeAppearance({ ...manifest, defaultVariant: "missing" }).status, "failure");
    assert.equal(
      normalizeAppearance({ ...manifest, variants: [manifest.variants[0], manifest.variants[0]] })
        .status,
      "failure",
    );
    assert.equal(
      normalizeAppearance({ ...manifest, assets: [manifest.assets[0], manifest.assets[0]] }).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance({ version: 1, name: "No Colors", appearance: "light" }).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance(
        {
          version: 1,
          name: "Exported",
          appearance: T3_CHAT_THEME.appearance,
          colors: T3_CHAT_THEME.colors,
        },
        { sourceId: "Invalid ID" },
      ).status,
      "failure",
    );
  });
  it("rejects invalid metric ordering and unsafe asset declarations", () => {
    const manifest = manifestV2();
    const variant = manifest.variants[0];
    const image = manifest.assets[0];
    if (variant?.metrics === undefined || image === undefined)
      assert.fail("Fixture is incomplete.");
    assert.equal(
      normalizeAppearance({
        ...manifest,
        variants: [
          {
            ...variant,
            metrics: {
              ...variant.metrics,
              sizing: {
                ...variant.metrics.sizing,
                sidebar: {
                  ...variant.metrics.sizing.sidebar,
                  minimumPx: variant.metrics.sizing.sidebar.maximumPx + 1,
                },
              },
            },
          },
        ],
        defaultVariant: variant.id,
      }).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance({
        ...manifest,
        assets: [{ ...image, path: "a/b/c/d/e/f/g/h/image.webp" }],
      }).status,
      "failure",
    );
    for (const path of ["images//hero.webp", "./hero.webp", "images/"]) {
      assert.equal(
        normalizeAppearance({
          ...manifest,
          assets: [{ ...image, path }],
        }).status,
        "failure",
      );
    }
    assert.equal(
      normalizeAppearance({
        ...manifest,
        assets: [{ ...image, mimeType: "image/svg+xml" }],
      }).status,
      "failure",
    );
  });
  it("returns schema-valid diagnostics for maximum bounded paths", () => {
    const manifest = manifestV2();
    const longStylePath = `${Array.from({ length: 9 }, (_, index) => `segment-${index}`).join("/")}.css`;
    const diagnosticResult = normalizeAppearance(
      {
        ...manifest,
        capabilities: [...manifest.capabilities, "shared-css"],
        styles: {
          web: {
            path: longStylePath,
            sha256: "d".repeat(64),
            sizeBytes: 1024,
          },
        },
      },
      {
        trust: {
          class: "local-package",
          allowSharedCss: true,
          allowDesktopCss: false,
          allowAdvancedSnippet: false,
        },
      },
    );
    assert.equal(diagnosticResult.status, "failure");
    if (diagnosticResult.status === "failure") {
      assert.doesNotThrow(() =>
        decodeAppearanceDiagnostic(diagnosticResult.diagnostic, STRICT_APPEARANCE_PARSE_OPTIONS),
      );
    }
  });

  it("preserves explicit missing-mode fallback policy and stylesheet identity", () => {
    const manifest = manifestV2();
    const dark = manifest.variants.find((variant) => variant.appearance === "dark");
    if (dark === undefined) assert.fail("Fixture has no dark variant.");
    const profile = requireSuccess({
      ...manifest,
      fallback: { light: "reject", dark: "default-variant" },
      defaultVariant: dark.id,
      variants: [dark],
    });
    assert.deepStrictEqual(profile.fallback, { light: "reject", dark: "default-variant" });
    assert.deepStrictEqual(profile.styles, {});
  });

  it("requires installation-bound grants for executable CSS capabilities", () => {
    const manifest = manifestV2();
    const cssManifest = {
      ...manifest,
      capabilities: [...manifest.capabilities, "shared-css" as const],
      styles: {
        web: {
          path: "theme.css",
          sha256: "c".repeat(64),
          sizeBytes: 1024,
        },
      },
    };
    const denied = normalizeAppearance(cssManifest);
    assert.equal(denied.status, "failure");
    if (denied.status === "failure") {
      assert.equal(denied.diagnostic.code, "unsupported-capability");
    }
    const granted = normalizeAppearance(cssManifest, {
      trust: {
        class: "local-package",
        allowSharedCss: true,
        allowDesktopCss: false,
        allowAdvancedSnippet: false,
      },
    });
    assert.equal(granted.status, "success");
    if (granted.status === "success") {
      assert.include(granted.profile.requestedCapabilities, "shared-css");
      assert.include(granted.profile.capabilities, "shared-css");
      assert.equal(granted.profile.styles.web?.path, "theme.css");
    }
    assert.equal(
      normalizeAppearance(cssManifest, {
        trust: {
          class: "environment-palette",
          allowSharedCss: true,
          allowDesktopCss: false,
          allowAdvancedSnippet: false,
        },
      }).status,
      "failure",
    );
  });

  it("returns exhaustive compatibility diagnostics instead of partial profiles", () => {
    const manifest = manifestV2();
    const tooOld = normalizeAppearance(manifest, { appVersion: "1.1.9" });
    assert.equal(tooOld.status, "failure");
    if (tooOld.status === "failure")
      assert.equal(tooOld.diagnostic.code, "incompatible-app-version");

    const platform = normalizeAppearance(manifest, { platform: "android" });
    assert.equal(platform.status, "failure");
    if (platform.status === "failure")
      assert.equal(platform.diagnostic.code, "unsupported-platform");

    const capability = normalizeAppearance(manifest, {
      supportedCapabilities: new Set(["colors"] as const),
    });
    assert.equal(capability.status, "failure");
    if (capability.status === "failure")
      assert.equal(capability.diagnostic.code, "unsupported-capability");
    assert.equal(
      normalizeAppearance({
        ...manifest,
        compatibility: {
          ...manifest.compatibility,
          minimumAppVersion: "1.0.0-alpha-2",
          maximumAppVersion: "1.0.0-alpha-1",
        },
      }).status,
      "failure",
    );
    assert.equal(
      normalizeAppearance({
        ...manifest,
        compatibility: {
          ...manifest.compatibility,
          minimumAppVersion: "4.0.0",
          maximumAppVersion: "3.0.0",
        },
      }).status,
      "failure",
    );
  });

  it("serializes and hashes canonically without locale or property-order dependence", () => {
    assert.equal(canonicalAppearanceJson({ z: 0, a: 1, ä: 2 }), '{"a":1,"z":0,"ä":2}');
    assert.equal(canonicalAppearanceJson({ value: -0 }), '{"value":0}');
    assert.equal(canonicalAppearanceJson({ "2": 2, "10": 1 }), '{"10":1,"2":2}');
    assert.equal(appearanceSha256({ b: 2, a: 1 }), appearanceSha256({ a: 1, b: 2 }));
    assert.equal(
      appearanceSha256({ a: 1, b: 2 }),
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    assert.throws(() => canonicalAppearanceJson({ invalid: Number.NaN }), /non-finite/u);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalAppearanceJson(cyclic), /cyclic/u);
    assert.throws(() => canonicalAppearanceJson(Symbol("invalid")), /symbol/u);
    const sparse: unknown[] = [];
    sparse.length = 2;
    assert.throws(() => canonicalAppearanceJson(sparse), /sparse arrays/u);
    const manifest = manifestV2();
    const reordered = requireSuccess({
      ...manifest,
      capabilities: manifest.capabilities.toReversed(),
      compatibility: {
        ...manifest.compatibility,
        platforms: manifest.compatibility.platforms.toReversed(),
        requiredCapabilities: manifest.compatibility.requiredCapabilities.toReversed(),
      },
      assets: manifest.assets.toReversed(),
    });
    assert.equal(
      hashNormalizedAppearanceProfile(reordered),
      hashNormalizedAppearanceProfile(requireSuccess(manifest)),
    );
  });

  it("round-trips normalized profiles with a stable content hash", () => {
    const profile = requireSuccess(manifestV2());
    const encoded = canonicalAppearanceJson(profile);
    const decoded = decodeNormalizedAppearanceProfile(
      JSON.parse(encoded),
      STRICT_APPEARANCE_PARSE_OPTIONS,
    );
    assert.deepStrictEqual(decoded, profile);
    assert.equal(
      hashNormalizedAppearanceProfile(decoded),
      hashNormalizedAppearanceProfile(profile),
    );
  });
});
