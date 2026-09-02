import { describe, expect, it } from "@effect/vitest";

import {
  AppearanceCssValidationError,
  validateAppearancePackageCss,
  validateAppearanceSnippetCss,
  rewriteAppearancePackageCss,
} from "./css.ts";

describe("appearance CSS validation", () => {
  it("accepts parsed local declarations", () => {
    expect(() =>
      validateAppearancePackageCss(":root { --app-theme-canvas: #123456; color: var(--x); }"),
    ).not.toThrow();
  });

  it.each([
    "@import url(https://example.com/theme.css);",
    ".x { background: url(javascript:alert(1)); }",
    '.x { background-image: image-set("https://example.com/x" 1x); }',
    ".x { background: paint(remote-worklet); }",
    "@unknown rule { .x { color: red; } }",
    ".x { color: red !important; }",
    ".x { color: ; } }",
  ])("rejects unsafe package CSS %#", (source) => {
    expect(() => validateAppearancePackageCss(source)).toThrow(AppearanceCssValidationError);
  });

  it("allows explicit snippet priority but still blocks resource URLs", () => {
    expect(() => validateAppearanceSnippetCss(".x { color: red !important; }")).not.toThrow();
    expect(() =>
      validateAppearanceSnippetCss(".x { background: url(https://example.com/x); }"),
    ).toThrow("contained relative asset path");
  });

  it("rewrites only declared contained package assets", () => {
    const paths = new Set(["images/background.webp"]);
    expect(
      rewriteAppearancePackageCss(
        '.hero { background: url("./images/background.webp"); }',
        (path) => (path === "images/background.webp" ? "blob:appearance-background" : null),
        paths,
      ),
    ).toContain("url(blob:appearance-background)");
    expect(() =>
      rewriteAppearancePackageCss(
        ".hero { background: url(images/missing.webp); }",
        () => "blob:wrong",
        paths,
      ),
    ).toThrow("missing from the package");
  });

  it.each([
    "https://example.com/a.png",
    "javascript:alert(1)",
    "/absolute.png",
    "../escape.png",
    "images/a.png?remote=1",
    "images/a.png#fragment",
  ])("rejects unsafe asset URL %s", (url) => {
    expect(() =>
      rewriteAppearancePackageCss(
        `.hero { background: url(${JSON.stringify(url)}); }`,
        () => "blob:unexpected",
        new Set([url]),
      ),
    ).toThrow(AppearanceCssValidationError);
  });

  it("reports parser source locations", () => {
    try {
      validateAppearancePackageCss(".ok { color: red; }\n.bad { color: ; } }");
      throw new Error("Expected CSS validation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AppearanceCssValidationError);
      if (!(error instanceof AppearanceCssValidationError)) return;
      expect(error.diagnostics[0]).toMatchObject({ line: 2 });
      expect(error.diagnostics[0]?.column).toBeGreaterThan(0);
    }
  });
});
