import * as Schema from "effect/Schema";

export const EVIDENCE_SCHEMA_VERSION = 2 as const;
const SceneAppearance = Schema.Literals(["light", "dark", "both"]);
export type SceneAppearance = typeof SceneAppearance.Type;
const SceneClient = Schema.Literals(["web", "desktop", "ios", "android"]);
export type SceneClient = typeof SceneClient.Type;
const SceneStatus = Schema.Literals(["g0-baseline", "final-only"]);
export type SceneStatus = typeof SceneStatus.Type;
export const ScenePlanStatus = Schema.Literals(["ready", "blocked-product", "blocked-external"]);
export type ScenePlanStatus = typeof ScenePlanStatus.Type;
const EvidenceType = Schema.Literals([
  "screenshot",
  "accessibility",
  "dom",
  "style",
  "console",
  "trace",
]);
export type EvidenceType = typeof EvidenceType.Type;
const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));

export const SceneCardSchema = Schema.Struct({
  id: NonEmpty,
  label: NonEmpty,
  appearance: SceneAppearance,
  clients: Schema.Array(SceneClient),
  excludedClients: Schema.Array(SceneClient),
  state: NonEmpty,
  status: SceneStatus,
  evidenceTypes: Schema.Array(EvidenceType),
  readyGuard: NonEmpty,
  driverKey: NonEmpty,
  nonApplicability: NonEmpty,
});
export type SceneCard = typeof SceneCardSchema.Type;
export const SceneCatalogSchema = Schema.Struct({
  schemaVersion: Schema.Literal(EVIDENCE_SCHEMA_VERSION),
  cards: Schema.Array(SceneCardSchema),
});
export type SceneCatalog = typeof SceneCatalogSchema.Type;
export const ScenePlanRowSchema = Schema.Struct({
  cardId: NonEmpty,
  client: SceneClient,
  status: ScenePlanStatus,
});
export type ScenePlanRow = typeof ScenePlanRowSchema.Type;

interface SceneCardSeed {
  readonly id: string;
  readonly label: string;
  readonly state: string;
}
const allClients = [
  "web",
  "desktop",
  "ios",
  "android",
] as const satisfies ReadonlyArray<SceneClient>;
export const REQUIRED_SCENE_IDS = [
  "workspace-empty",
  "sidebar-populated",
  "names-long",
  "badges",
  "hover",
  "selected",
  "drag",
  "collapsed",
  "task-new",
  "composer-existing-thread",
  "autocomplete",
  "attachments",
  "mode-plan",
  "mode-default",
  "turn-pending",
  "turn-running",
  "markdown-headings",
  "markdown-tables",
  "markdown-quotes",
  "markdown-links",
  "code-inline",
  "code-fenced",
  "streaming",
  "tool-calls",
  "approvals",
  "checkpoints",
  "errors",
  "diff-split",
  "diff-unified",
  "additions",
  "deletions",
  "comments",
  "files-collapsed",
  "lines-long",
  "file-tree",
  "preview-image",
  "preview-text",
  "terminal-ansi-palette",
  "terminal-selection",
  "terminal-cursor",
  "terminal-search",
  "terminal-resize",
  "tabs-multiple",
  "disconnected",
  "reconnect",
  "settings-theme-library",
  "settings-editor",
  "settings-snippets",
  "settings-diagnostics",
  "settings-import",
  "settings-compatibility",
  "settings-quarantine",
  "settings-reset",
  "command-palette",
  "context-menu",
  "popover",
  "tooltip",
  "toast",
  "dialog",
  "auth",
  "pairing",
  "offline",
  "update",
  "fatal-error",
  "preview-chrome",
  "annotation",
  "typography-minimum",
  "typography-maximum",
  "density-minimum",
  "density-maximum",
  "appearance-light",
  "appearance-dark",
  "contrast-high",
  "motion-reduced",
  "theme-built-in",
  "theme-v1-migrated",
  "package-manifest-only",
  "package-css",
  "package-font",
  "snippets-multiple",
  "snippet-broken",
  "mode-safe",
  "desktop-macos",
  "desktop-windows",
  "desktop-linux",
  "browser-hosted",
  "browser-local",
  "ios",
  "android",
] as const;
const visualEvidence = [
  "screenshot",
  "accessibility",
] as const satisfies ReadonlyArray<EvidenceType>;
type SceneSeedTuple = readonly [id: string, label: string, state: string];
const seedGroups: ReadonlyArray<ReadonlyArray<SceneSeedTuple>> = [
  [
    ["workspace-empty", "empty workspace", "empty"],
    ["sidebar-populated", "populated sidebar", "populated"],
    ["names-long", "long names", "long-names"],
    ["badges", "badges", "badges"],
    ["hover", "hover", "hover"],
    ["selected", "selected", "selected"],
    ["drag", "drag", "drag"],
    ["collapsed", "collapsed states", "collapsed"],
  ],
  [
    ["task-new", "new task", "new-task"],
    ["composer-existing-thread", "existing thread composer", "existing-thread"],
    ["autocomplete", "autocomplete", "autocomplete"],
    ["attachments", "attachments", "attachments"],
    ["mode-plan", "plan mode", "plan"],
    ["mode-default", "default mode", "default"],
    ["turn-pending", "pending turn", "pending"],
    ["turn-running", "running turn", "running"],
  ],
  [
    ["markdown-headings", "markdown headings", "headings"],
    ["markdown-tables", "markdown tables", "tables"],
    ["markdown-quotes", "markdown quotes", "quotes"],
    ["markdown-links", "markdown links", "links"],
    ["code-inline", "inline code", "inline-code"],
    ["code-fenced", "fenced code", "fenced-code"],
    ["streaming", "streaming", "streaming"],
    ["tool-calls", "tool calls", "tool-calls"],
    ["approvals", "approvals", "approvals"],
    ["checkpoints", "checkpoints", "checkpoints"],
    ["errors", "errors", "errors"],
  ],
  [
    ["diff-split", "diff split view", "split"],
    ["diff-unified", "diff unified view", "unified"],
    ["additions", "additions", "additions"],
    ["deletions", "deletions", "deletions"],
    ["comments", "comments", "comments"],
    ["files-collapsed", "collapsed files", "collapsed-files"],
    ["lines-long", "long lines", "long-lines"],
    ["file-tree", "file tree", "file-tree"],
    ["preview-image", "image preview", "image"],
    ["preview-text", "text preview", "text"],
  ],
  [
    ["terminal-ansi-palette", "terminal ANSI palette", "ansi-palette"],
    ["terminal-selection", "terminal selection", "selection"],
    ["terminal-cursor", "terminal cursor", "cursor"],
    ["terminal-search", "terminal search", "search"],
    ["terminal-resize", "terminal resize", "resize"],
    ["tabs-multiple", "multiple tabs", "multiple-tabs"],
    ["disconnected", "disconnected state", "disconnected"],
    ["reconnect", "reconnect state", "reconnect"],
  ],
  [
    ["settings-theme-library", "settings theme library", "theme-library"],
    ["settings-editor", "settings editor", "editor"],
    ["settings-snippets", "settings snippets", "snippets"],
    ["settings-diagnostics", "settings diagnostics", "diagnostics"],
    ["settings-import", "settings import", "import"],
    ["settings-compatibility", "settings compatibility", "compatibility"],
    ["settings-quarantine", "settings quarantine", "quarantine"],
    ["settings-reset", "settings reset", "reset"],
  ],
  [
    ["command-palette", "command palette", "command-palette"],
    ["context-menu", "context menu", "context-menu"],
    ["popover", "popover", "popover"],
    ["tooltip", "tooltip", "tooltip"],
    ["toast", "toast", "toast"],
    ["dialog", "dialog", "dialog"],
    ["auth", "auth", "auth"],
    ["pairing", "pairing", "pairing"],
    ["offline", "offline", "offline"],
    ["update", "update", "update"],
    ["fatal-error", "fatal error", "fatal-error"],
  ],
  [
    ["preview-chrome", "browser preview chrome", "preview-chrome"],
    ["annotation", "browser annotation", "annotation"],
  ],
  [
    ["typography-minimum", "minimum supported typography", "minimum"],
    ["typography-maximum", "maximum supported typography", "maximum"],
    ["density-minimum", "minimum supported density", "minimum"],
    ["density-maximum", "maximum supported density", "maximum"],
  ],
  [
    ["appearance-light", "light appearance", "light"],
    ["appearance-dark", "dark appearance", "dark"],
    ["contrast-high", "high contrast", "high-contrast"],
    ["motion-reduced", "reduced motion", "reduced-motion"],
  ],
  [
    ["theme-built-in", "built-in theme", "built-in"],
    ["theme-v1-migrated", "version 1 migrated theme", "v1-migrated"],
    ["package-manifest-only", "manifest-only package", "manifest-only"],
    ["package-css", "CSS package", "css-package"],
    ["package-font", "package font", "font"],
    ["snippets-multiple", "multiple snippets", "multiple-snippets"],
    ["snippet-broken", "broken snippet", "broken-snippet"],
    ["mode-safe", "safe mode", "safe"],
  ],
  [
    ["desktop-macos", "desktop macOS", "macos"],
    ["desktop-windows", "desktop Windows", "windows"],
    ["desktop-linux", "desktop Linux", "linux"],
    ["browser-hosted", "hosted browser", "hosted"],
    ["browser-local", "local browser", "local"],
    ["ios", "iOS", "ios"],
    ["android", "Android", "android"],
  ],
];
const seeds: ReadonlyArray<SceneCardSeed> = seedGroups.flatMap((group) =>
  group.map(([id, label, state]) => ({ id, label, state })),
);
const finalOnlyIds = new Set([
  "settings-snippets",
  "settings-diagnostics",
  "settings-compatibility",
  "settings-quarantine",
  "settings-reset",
  "theme-v1-migrated",
  "package-manifest-only",
  "package-css",
  "package-font",
  "snippets-multiple",
  "snippet-broken",
  "mode-safe",
]);
const desktopOnlyIds = new Set(["desktop-macos", "desktop-windows", "desktop-linux"]);
const mobileOnlyIds = new Map<string, SceneClient>([
  ["ios", "ios"],
  ["android", "android"],
]);
const webAndDesktopIds = new Set(["preview-chrome", "annotation"]);
const webOnlyIds = new Set(["browser-hosted", "browser-local"]);

function createSceneCard(seed: SceneCardSeed): SceneCard {
  const mobileClient = mobileOnlyIds.get(seed.id);
  const clients: ReadonlyArray<SceneClient> = mobileClient
    ? [mobileClient]
    : webAndDesktopIds.has(seed.id)
      ? ["web", "desktop"]
      : webOnlyIds.has(seed.id)
        ? ["web"]
        : desktopOnlyIds.has(seed.id)
          ? ["desktop"]
          : allClients;
  const excludedClients = allClients.filter((client) => !clients.includes(client));
  const finalOnly = finalOnlyIds.has(seed.id);
  return {
    id: seed.id,
    label: seed.label,
    appearance:
      seed.id === "appearance-light" ? "light" : seed.id === "appearance-dark" ? "dark" : "both",
    clients,
    excludedClients,
    state: seed.state,
    status: finalOnly ? "final-only" : "g0-baseline",
    evidenceTypes:
      clients.includes("web") || clients.includes("desktop")
        ? [...visualEvidence, "dom", "style", "console"]
        : [...visualEvidence],
    readyGuard: `appearance.scene.${seed.id}.ready`,
    driverKey: `appearance.${seed.id}`,
    nonApplicability:
      excludedClients.length === 0 ? "none" : `Not applicable to ${excludedClients.join(", ")}.`,
  };
}
export const APPEARANCE_SCENE_CATALOG: ReadonlyArray<SceneCard> = seeds.map(createSceneCard);

export function validateSceneCatalog(catalog: ReadonlyArray<SceneCard>): ReadonlyArray<SceneCard> {
  const ids = new Set<string>();
  for (const [index, card] of catalog.entries()) {
    if (!card || typeof card !== "object") throw new Error(`Scene card ${index} is not an object.`);
    if (!card.id) throw new Error(`Scene card ${index} is missing id metadata.`);
    if (ids.has(card.id)) throw new Error(`Duplicate scene card id '${card.id}'.`);
    ids.add(card.id);
    if (
      !card.appearance ||
      !card.state ||
      !card.status ||
      card.evidenceTypes.length === 0 ||
      !card.readyGuard ||
      !card.driverKey ||
      !card.nonApplicability
    )
      throw new Error(`Scene card '${card.id}' is missing required metadata.`);
    const applicable = new Set(card.clients);
    const excluded = new Set(card.excludedClients);
    const evidenceTypes = new Set(card.evidenceTypes);
    if (
      applicable.size === 0 ||
      applicable.size !== card.clients.length ||
      excluded.size !== card.excludedClients.length ||
      applicable.size + excluded.size !== allClients.length ||
      allClients.some((client) => applicable.has(client) === excluded.has(client))
    ) {
      throw new Error(
        `Scene card '${card.id}' must declare every client as applicable or excluded exactly once.`,
      );
    }
    if (
      evidenceTypes.size !== card.evidenceTypes.length ||
      !evidenceTypes.has("screenshot") ||
      !evidenceTypes.has("accessibility")
    ) {
      throw new Error(
        `Scene card '${card.id}' must declare unique screenshot and accessibility evidence.`,
      );
    }
  }
  const required = new Set(REQUIRED_SCENE_IDS);
  if (ids.size !== required.size || [...required].some((id) => !ids.has(id)))
    throw new Error("Scene catalog does not contain the exact required scene ID set.");
  return Schema.decodeUnknownSync(SceneCatalogSchema)({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    cards: catalog,
  }).cards;
}
const DEFAULT_AVAILABLE_CLIENTS: ReadonlySet<SceneClient> = new Set();
function appearancePlanStatus(
  card: SceneCard,
  client: SceneClient,
  availableClients: ReadonlySet<SceneClient>,
): ScenePlanStatus {
  if (card.status === "final-only") return "blocked-product";
  return availableClients.has(client) ? "ready" : "blocked-external";
}

export function planAppearanceCatalog(
  catalog: ReadonlyArray<SceneCard> = APPEARANCE_SCENE_CATALOG,
  availableClients: ReadonlySet<SceneClient> = DEFAULT_AVAILABLE_CLIENTS,
): {
  readonly cards: ReadonlyArray<SceneCard>;
  readonly rows: ReadonlyArray<ScenePlanRow>;
  readonly blockedExternal: ReadonlyArray<SceneCard>;
} {
  const cards = validateSceneCatalog(catalog);
  const rows = cards.flatMap((card) =>
    card.clients.map((client) => ({
      cardId: card.id,
      client,
      status: appearancePlanStatus(card, client, availableClients),
    })),
  );
  return {
    cards,
    rows: Schema.decodeUnknownSync(Schema.Array(ScenePlanRowSchema))(rows),
    blockedExternal: cards.filter((card) =>
      rows.some((row) => row.cardId === card.id && row.status === "blocked-external"),
    ),
  };
}
validateSceneCatalog(APPEARANCE_SCENE_CATALOG);
