import {
  APPEARANCE_ANSI_ROLES,
  type AppearanceDiff,
  type AppearanceSyntax,
  type AppearanceTerminal,
  type NormalizedAppearanceVariant,
} from "@t3tools/shared/appearance";

/** CSS variables owned by web renderers. Values always come from a normalized variant. */
export function appearanceVariantDeclarations(variant: NormalizedAppearanceVariant): string {
  const declarations: string[] = [];
  declarations.push(
    `--terminal-background:${variant.terminal.background};`,
    `--terminal-foreground:${variant.terminal.foreground};`,
    `--terminal-cursor:${variant.terminal.cursor};`,
    `--terminal-selection-background:${variant.terminal.selection};`,
    `--terminal-scrollbar:${variant.terminal.scrollbar};`,
    `--terminal-scrollbar-hover:${variant.terminal.scrollbarHover};`,
  );
  for (const role of APPEARANCE_ANSI_ROLES) {
    declarations.push(`--terminal-ansi-${role}:${variant.terminal.ansi[role]};`);
  }
  declarations.push(
    `--diffs-bg:${variant.diff.background};`,
    `--diffs-fg:${variant.diff.foreground};`,
    `--diffs-bg-context:${variant.diff.gutterBackground};`,
    `--diffs-bg-context-gutter:${variant.diff.gutterBackground};`,
    `--diffs-bg-separator:${variant.diff.hunkBackground};`,
    `--diffs-fg-number:${variant.diff.lineNumberForeground};`,
    `--diffs-addition-base:${variant.diff.additionForeground};`,
    `--diffs-deletion-base:${variant.diff.deletionForeground};`,
    `--diffs-modified-base:${variant.diff.modificationForeground};`,
    `--diffs-bg-modification:${variant.diff.modificationBackground};`,
    `--diffs-fg-gutter:${variant.diff.gutterForeground};`,
    `--diffs-fg-hunk:${variant.diff.hunkForeground};`,
    `--diffs-bg-addition:${variant.diff.additionBackground};`,
    `--diffs-bg-deletion:${variant.diff.deletionBackground};`,
    `--diffs-bg-selection:${variant.diff.selectionBackground};`,
    `--diffs-annotation-bg:${variant.diff.commentBackground};`,
    `--diffs-header-bg:${variant.diff.headerBackground};`,
    `--diffs-header-fg:${variant.diff.headerForeground};`,
    `--diffs-font-family:var(--font-code);`,
    `--diffs-header-font-family:var(--font-interface);`,
    `--diffs-font-size:var(--font-size-code);`,
    `--diffs-line-height:var(--line-height-code);`,
  );
  for (const [index, token] of variant.syntax.tokens.entries()) {
    declarations.push(`--syntax-token-${index}-foreground:${token.foreground};`);
    declarations.push(`--syntax-token-${index}-background:${token.background ?? "transparent"};`);
    declarations.push(
      `--syntax-token-${index}-font-style:${token.fontStyle.join(" ") || "normal"};`,
    );
  }
  return declarations.join("");
}

export function appearanceVariantCss(variant: NormalizedAppearanceVariant): string {
  return `:root{${appearanceVariantDeclarations(variant)}}`;
}

export function terminalAppearanceVariables(
  terminal: AppearanceTerminal,
): Readonly<Record<string, string>> {
  return {
    "--terminal-background": terminal.background,
    "--terminal-foreground": terminal.foreground,
    "--terminal-cursor": terminal.cursor,
    "--terminal-selection-background": terminal.selection,
    "--terminal-scrollbar": terminal.scrollbar,
    "--terminal-scrollbar-hover": terminal.scrollbarHover,
    ...Object.fromEntries(
      APPEARANCE_ANSI_ROLES.map((role) => [`--terminal-ansi-${role}`, terminal.ansi[role]]),
    ),
  };
}

export function diffAppearanceVariables(diff: AppearanceDiff): Readonly<Record<string, string>> {
  return {
    "--diffs-bg": diff.background,
    "--diffs-fg": diff.foreground,
    "--diffs-bg-context": diff.gutterBackground,
    "--diffs-bg-context-gutter": diff.gutterBackground,
    "--diffs-bg-separator": diff.hunkBackground,
    "--diffs-fg-number": diff.lineNumberForeground,
    "--diffs-addition-base": diff.additionForeground,
    "--diffs-deletion-base": diff.deletionForeground,
    "--diffs-modified-base": diff.modificationForeground,
    "--diffs-bg-modification": diff.modificationBackground,
    "--diffs-fg-gutter": diff.gutterForeground,
    "--diffs-fg-hunk": diff.hunkForeground,
    "--diffs-bg-addition": diff.additionBackground,
    "--diffs-bg-deletion": diff.deletionBackground,
    "--diffs-bg-selection": diff.selectionBackground,
    "--diffs-annotation-bg": diff.commentBackground,
    "--diffs-header-bg": diff.headerBackground,
    "--diffs-header-fg": diff.headerForeground,
  };
}

export function syntaxAppearanceVariables(
  syntax: AppearanceSyntax,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    syntax.tokens.flatMap((token, index) => [
      [`--syntax-token-${index}-foreground`, token.foreground],
      [`--syntax-token-${index}-background`, token.background ?? "transparent"],
      [`--syntax-token-${index}-font-style`, token.fontStyle.join(" ") || "normal"],
    ]),
  );
}
