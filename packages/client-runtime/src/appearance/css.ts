import { generate, parse, walk, type CssNode } from "css-tree";

const SUPPORTED_AT_RULES: Readonly<Record<string, true>> = {
  charset: true,
  container: true,
  "custom-media": true,
  document: true,
  "font-face": true,
  keyframes: true,
  layer: true,
  media: true,
  page: true,
  "position-try": true,
  property: true,
  scope: true,
  "starting-style": true,
  supports: true,
  viewport: true,
  "-webkit-keyframes": true,
};

export interface AppearanceCssDiagnostic {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly file?: string;
}

export class AppearanceCssValidationError extends Error {
  readonly diagnostics: ReadonlyArray<AppearanceCssDiagnostic>;

  constructor(diagnostics: ReadonlyArray<AppearanceCssDiagnostic>) {
    super(diagnostics[0]?.message ?? "Appearance CSS is invalid.");
    this.name = "AppearanceCssValidationError";
    this.diagnostics = diagnostics;
  }
}

function location(node: CssNode): Pick<AppearanceCssDiagnostic, "line" | "column"> {
  return {
    line: node.loc?.start.line ?? 1,
    column: node.loc?.start.column ?? 1,
  };
}

function offsetLocation(
  source: string,
  offset: number,
): Pick<AppearanceCssDiagnostic, "line" | "column"> {
  const prefix = source.slice(0, Math.max(0, offset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function validationError(
  diagnostics: ReadonlyArray<AppearanceCssDiagnostic>,
  file: string | undefined,
): AppearanceCssValidationError {
  return new AppearanceCssValidationError(
    file === undefined ? diagnostics : diagnostics.map((diagnostic) => ({ ...diagnostic, file })),
  );
}

function normalizeAssetPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const path = decoded.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path)
  ) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function parseAppearanceCss(
  source: string,
  options: {
    readonly allowImportant: boolean;
    readonly allowedAssetPaths: ReadonlySet<string>;
    readonly rewriteAsset?: (path: string) => string | null;
    readonly file?: string;
  },
): CssNode {
  const diagnostics: AppearanceCssDiagnostic[] = [];
  let ast: CssNode;
  try {
    ast = parse(source, {
      positions: true,
      parseCustomProperty: true,
      onParseError: (error) => {
        diagnostics.push({
          message: error.message,
          ...offsetLocation(source, error.offset),
        });
      },
    });
  } catch (error) {
    const syntax = error as {
      readonly message?: unknown;
      readonly line?: unknown;
      readonly column?: unknown;
    };
    diagnostics.push({
      message: typeof syntax.message === "string" ? syntax.message : "Appearance CSS is malformed.",
      line: typeof syntax.line === "number" ? syntax.line : 1,
      column: typeof syntax.column === "number" ? syntax.column : 1,
    });
    throw validationError(diagnostics, options.file);
  }

  walk(ast, (node) => {
    if (node.type === "Atrule") {
      const name = node.name.toLowerCase();
      if (name === "import") {
        diagnostics.push({ message: "Appearance CSS cannot use @import.", ...location(node) });
        return;
      }
      if (SUPPORTED_AT_RULES[name] !== true) {
        diagnostics.push({
          message: `Appearance CSS does not support the @${node.name} at-rule.`,
          ...location(node),
        });
      }
    }
    if (node.type === "Function") {
      const name = node.name.toLowerCase();
      if (
        name === "image" ||
        name === "image-set" ||
        name === "-webkit-image-set" ||
        name === "cross-fade" ||
        name === "paint" ||
        name === "src"
      ) {
        diagnostics.push({
          message: `Appearance CSS cannot use resource-bearing ${node.name}().`,
          ...location(node),
        });
        return;
      }
    }
    if (node.type === "Url") {
      const path = normalizeAssetPath(node.value);
      if (path === null) {
        diagnostics.push({
          message: "Appearance CSS URL must be a contained relative asset path.",
          ...location(node),
        });
        return;
      }
      if (!options.allowedAssetPaths.has(path)) {
        diagnostics.push({
          message: `Appearance CSS asset is missing from the package: ${path}.`,
          ...location(node),
        });
        return;
      }
      if (options.rewriteAsset !== undefined) {
        const rewritten = options.rewriteAsset(path);
        if (rewritten === null) {
          diagnostics.push({
            message: `Appearance CSS asset could not be registered: ${path}.`,
            ...location(node),
          });
        } else {
          node.value = rewritten;
        }
      }
      return;
    }
    if (node.type === "Declaration" && node.important && !options.allowImportant) {
      diagnostics.push({ message: "Package CSS cannot use !important.", ...location(node) });
    }
  });

  if (diagnostics.length > 0) throw validationError(diagnostics, options.file);
  return ast;
}

/** Parse distributable package CSS before persistence or injection. */
export function validateAppearancePackageCss(
  source: string,
  allowedAssetPaths: ReadonlySet<string> = new Set(),
  file?: string,
): void {
  parseAppearanceCss(source, {
    allowImportant: false,
    allowedAssetPaths,
    ...(file === undefined ? {} : { file }),
  });
}

/** Parse and replace each declared package asset URL with a contained runtime URL. */
export function rewriteAppearancePackageCss(
  source: string,
  resolveAsset: (path: string) => string | null,
  allowedAssetPaths: ReadonlySet<string>,
  file?: string,
): string {
  return generate(
    parseAppearanceCss(source, {
      allowImportant: false,
      allowedAssetPaths,
      rewriteAsset: resolveAsset,
      ...(file === undefined ? {} : { file }),
    }),
  );
}

/** Parse local advanced CSS while retaining its explicit cascade authority. */
export function validateAppearanceSnippetCss(source: string, file?: string): void {
  parseAppearanceCss(source, {
    allowImportant: true,
    allowedAssetPaths: new Set(),
    ...(file === undefined ? {} : { file }),
  });
}
