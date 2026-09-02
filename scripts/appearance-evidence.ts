#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Evidence sealing verifies exact host filesystem bytes and containment.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

import {
  EVIDENCE_ENV_ALLOWLIST,
  commandOutput,
  createActualSurfaceChildEnv,
} from "./actual-surface-environment.ts";
import {
  APPEARANCE_SCENE_CATALOG,
  EVIDENCE_SCHEMA_VERSION,
  planAppearanceCatalog,
  validateSceneCatalog,
  type SceneCard,
  type SceneCatalog,
  type ScenePlanRow,
  type SceneClient,
} from "./appearance-evidence.config.ts";
import { runWebAppearanceDriver } from "./appearance-evidence-web.ts";
import { runDesktopAppearanceDriver } from "./appearance-evidence-desktop.ts";
import type { AppearanceDriverResult, DriverArtifact } from "./appearance-evidence-web.ts";

export const APPEARANCE_CONTRACT_IDENTITY_SHA256 =
  "f474031d280c1b9cd95cdf6c731cef60044ebeffd062988d95eed3dc2095d8ea" as const;
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const NonNegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Client = Schema.Literals(["web", "desktop", "ios", "android"]);
const MetricAppearance = Schema.Literals(["light", "dark"]);
const MetricKind = Schema.Literals([
  "cold-startup",
  "warm-switch",
  "react-commits",
  "long-task",
  "stylesheet-count",
  "memory",
]);
export type MetricKind = typeof MetricKind.Type;

export const ArtifactIdentitySchema = Schema.Struct({
  baseCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/u)),
  trackedDiffSha256: Sha256,
  untrackedProductManifestSha256: Schema.NullOr(Sha256),
  contractIdentitySha256: Sha256,
});
export type ArtifactIdentity = typeof ArtifactIdentitySchema.Type;
export const RuntimeIdentitySchema = Schema.Struct({
  node: Schema.NullOr(NonEmpty),
  platform: Schema.NullOr(NonEmpty),
  architecture: Schema.NullOr(NonEmpty),
  server: Schema.NullOr(NonEmpty),
  tool: Schema.NullOr(NonEmpty),
  browser: Schema.NullOr(NonEmpty),
  electron: Schema.NullOr(NonEmpty),
  mobile: Schema.NullOr(NonEmpty),
});
export type RuntimeIdentity = typeof RuntimeIdentitySchema.Type;
export const MetricSampleSchema = Schema.Struct({
  kind: MetricKind,
  client: Client,
  appearance: MetricAppearance,
  value: NonNegative,
  unit: NonEmpty,
  sampleIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MetricSample = typeof MetricSampleSchema.Type;
export const MetricSummarySchema = Schema.Struct({
  kind: MetricKind,
  client: Client,
  appearance: MetricAppearance,
  unit: NonEmpty,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  median: NonNegative,
  p95: NonNegative,
  max: NonNegative,
});
export type MetricSummary = typeof MetricSummarySchema.Type;
const EvidenceWorkloadSchema = Schema.Struct({
  coldLaunchesPerAppearance: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  alternatingPairs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  switches: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const EvidencePromotionSchema = Schema.Struct({
  status: Schema.Literals(["promotable", "non-promotable", "blocked"]),
  client: Client,
  smokeOnly: Schema.Boolean,
  requestedWorkload: EvidenceWorkloadSchema,
  observedWorkload: EvidenceWorkloadSchema,
  requiredCardCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  capturedCardCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reasons: Schema.Array(NonEmpty),
});
export type EvidencePromotion = typeof EvidencePromotionSchema.Type;
export const EvidenceLeafSchema = Schema.Struct({ path: NonEmpty, sha256: Sha256 });
export type EvidenceLeaf = typeof EvidenceLeafSchema.Type;
export const EvidenceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(EVIDENCE_SCHEMA_VERSION),
  runId: NonEmpty,
  artifactIdentity: ArtifactIdentitySchema,
  runtimeIdentity: RuntimeIdentitySchema,
  promotion: EvidencePromotionSchema,
  commandIdentitySha256: Sha256,
  seedManifestSha256: Sha256,
  cards: Schema.Array(NonEmpty),
  leaves: Schema.Array(EvidenceLeafSchema),
  manifestHash: Sha256,
});
export type EvidenceManifest = typeof EvidenceManifestSchema.Type;

export { EVIDENCE_ENV_ALLOWLIST };
export function createEvidenceChildEnv(
  base: Readonly<Record<string, string | undefined>> = NodeProcess.env,
  overrides: Readonly<Partial<Record<(typeof EVIDENCE_ENV_ALLOWLIST)[number], string>>> = {},
): Readonly<Record<string, string>> {
  return createActualSurfaceChildEnv(base, overrides);
}
export function redactEvidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.replace(/[?#][^\s]*/gu, "");
  }
}
export function redactEvidenceText(value: string, secrets: ReadonlyArray<string> = []): string {
  let result = value;
  for (const secret of secrets)
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  result = result.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gu, (url) => redactEvidenceUrl(url));
  result = result.replace(
    /((?:token|secret|password|credential|api[_-]?key|authorization)\s*[=:]\s*)(?:bearer\s+)?[^\s,;}]+/giu,
    "$1[REDACTED]",
  );
  return result.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]");
}

type JsonPrimitive = string | number | boolean | null;
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function isJsonArray(value: JsonValue): value is ReadonlyArray<JsonValue> {
  return Array.isArray(value);
}
export function canonicalJson(value: JsonValue): string {
  const normalize = (entry: JsonValue): JsonValue => {
    if (isJsonArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      const ordered: Record<string, JsonValue> = {};
      for (const key of Object.keys(entry).sort(compareCanonicalText))
        ordered[key] = normalize(entry[key]!);
      return ordered;
    }
    if (typeof entry === "number" && !Number.isFinite(entry))
      throw new Error("Canonical JSON does not support non-finite numbers.");
    return entry;
  };
  return JSON.stringify(normalize(value));
}
export function sha256Hex(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}
export function hashProductInputs(
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
): string {
  const normalized: JsonObject[] = [];
  const seen = new Set<string>();
  for (const file of [...files].sort((left, right) =>
    compareCanonicalText(left.path, right.path),
  )) {
    if (
      !file.path ||
      NodePath.isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === "" || part === "..")
    )
      throw new Error(`Invalid product input path '${file.path}'.`);
    if (seen.has(file.path)) throw new Error(`Duplicate product input path '${file.path}'.`);
    seen.add(file.path);
    normalized.push({ path: file.path, sha256: Schema.decodeUnknownSync(Sha256)(file.sha256) });
  }
  return sha256Hex(canonicalJson(normalized));
}
export function createArtifactIdentity(input: {
  readonly baseCommit: string;
  readonly trackedDiffSha256: string;
  readonly untrackedProductManifestSha256: string | null;
  readonly contractIdentitySha256: string;
}): ArtifactIdentity {
  return Schema.decodeUnknownSync(ArtifactIdentitySchema)(input);
}
export function createRuntimeIdentity(input: Partial<RuntimeIdentity> = {}): RuntimeIdentity {
  return Schema.decodeUnknownSync(RuntimeIdentitySchema)({
    node: input.node === undefined ? process.version : input.node,
    platform: input.platform === undefined ? process.platform : input.platform,
    architecture: input.architecture === undefined ? process.arch : input.architecture,
    server: input.server ?? null,
    tool: input.tool ?? null,
    browser: input.browser ?? null,
    electron: input.electron ?? null,
    mobile: input.mobile ?? null,
  });
}
const METRIC_UNITS: Readonly<Record<MetricKind, string>> = {
  "cold-startup": "ms",
  "warm-switch": "ms",
  "react-commits": "count",
  "long-task": "ms",
  "stylesheet-count": "count",
  memory: "bytes",
};
function decodeMetricSamples(samples: ReadonlyArray<MetricSample>): ReadonlyArray<MetricSample> {
  const decoded = samples.map((sample) => Schema.decodeUnknownSync(MetricSampleSchema)(sample));
  const seen = new Set<string>();
  for (const sample of decoded) {
    if (METRIC_UNITS[sample.kind] !== sample.unit)
      throw new Error(`Metric ${sample.kind} requires unit ${METRIC_UNITS[sample.kind]}.`);
    const key = `${sample.kind}\0${sample.client}\0${sample.appearance}\0${sample.unit}\0${sample.sampleIndex}`;
    if (seen.has(key)) throw new Error(`Duplicate metric sample index ${sample.sampleIndex}.`);
    seen.add(key);
  }
  return decoded;
}
export function aggregateMetricSamples(
  samples: ReadonlyArray<MetricSample>,
): ReadonlyArray<MetricSummary> {
  const groups = new Map<string, MetricSample[]>();
  for (const sample of decodeMetricSamples(samples)) {
    const key = `${sample.kind}\0${sample.client}\0${sample.appearance}\0${sample.unit}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([, group]) => {
      const first = group[0];
      if (!first) throw new Error("Metric aggregation received an empty group.");
      const values = group.map((sample) => sample.value).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return {
        kind: first.kind,
        client: first.client,
        appearance: first.appearance,
        unit: first.unit,
        count: values.length,
        median:
          values.length % 2 === 0
            ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2
            : (values[middle] ?? 0),
        p95: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0,
        max: values[values.length - 1] ?? 0,
      };
    });
}
export function hashEvidenceLeaf(path: string, content: string | Uint8Array): EvidenceLeaf {
  return { path, sha256: sha256Hex(typeof content === "string" ? Buffer.from(content) : content) };
}
function resolveExistingAncestor(path: string): string {
  let current = NodePath.resolve(path);
  const missing: string[] = [];
  while (!NodeFS.existsSync(current)) {
    missing.push(NodePath.basename(current));
    const parent = NodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolved = NodeFS.realpathSync.native(current);
  return missing.reverse().reduce((parent, part) => NodePath.join(parent, part), resolved);
}
function contained(candidate: string, parent: string): boolean {
  const relative = NodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}
function overlap(left: string, right: string): boolean {
  return contained(left, right) || contained(right, left);
}
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
export function assertEvidenceOutputRoot(input: {
  readonly outputRoot: string;
  readonly checkoutRoot: string;
  readonly resolvedGitDir: string;
  readonly t3Homes: ReadonlyArray<string>;
  readonly syntheticEnvironment?: string;
}): string {
  if (!NodePath.isAbsolute(input.outputRoot))
    throw new Error("Evidence output root must be absolute.");
  const outputRoot = resolveExistingAncestor(input.outputRoot);
  const forbidden = [
    input.checkoutRoot,
    input.resolvedGitDir,
    ...input.t3Homes,
    ...(input.syntheticEnvironment ? [input.syntheticEnvironment] : []),
  ].map(resolveExistingAncestor);
  if (forbidden.some((path) => overlap(outputRoot, path)))
    throw new Error(`Evidence output root overlaps a forbidden path: ${outputRoot}.`);
  return outputRoot;
}
export async function assertEvidenceRunDirectoryAvailable(runDirectory: string): Promise<void> {
  try {
    await NodeFSP.access(runDirectory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`Evidence run directory already exists: ${NodePath.resolve(runDirectory)}.`);
}
export async function createEvidenceRunDirectory(
  outputRoot: string,
  runId: string,
): Promise<string> {
  if (!NodePath.isAbsolute(outputRoot)) throw new Error("Evidence output root must be absolute.");
  if (runId === "." || runId === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId))
    throw new Error(`Invalid evidence run id '${runId}'.`);
  const realOutputRoot = await NodeFSP.realpath(outputRoot);
  const runDirectory = NodePath.join(realOutputRoot, runId);
  await NodeFSP.mkdir(runDirectory, { recursive: false, mode: 0o700 });
  await NodeFSP.chmod(runDirectory, 0o700);
  return runDirectory;
}
function validateLeafList(leaves: ReadonlyArray<EvidenceLeaf>): void {
  const paths = leaves.map((leaf) => leaf.path);
  const sorted = [...paths].sort(compareCanonicalText);
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      NodePath.isAbsolute(path) ||
      path === "." ||
      path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === "")
    )
      throw new Error(`Invalid evidence leaf path '${path}'.`);
    if (seen.has(path)) throw new Error(`Duplicate evidence leaf path '${path}'.`);
    seen.add(path);
  }
  if (paths.some((path, index) => path !== sorted[index]))
    throw new Error("Evidence leaves must be sorted by relative path.");
}
function validateCardList(cards: ReadonlyArray<string>): void {
  const sorted = [...cards].sort(compareCanonicalText);
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card)) throw new Error(`Duplicate evidence card '${card}'.`);
    seen.add(card);
  }
  if (cards.some((card, index) => card !== sorted[index]))
    throw new Error("Evidence cards must be sorted.");
}
const evidenceArtifactSuffix = {
  screenshot: "/screenshot.png",
  accessibility: "/aria.yaml",
  dom: "/dom.html",
  style: "/styles.txt",
  console: "/console.json",
  trace: "/trace.zip",
} as const;

function hasCompleteCardEvidence(card: SceneCard, leaves: ReadonlyArray<EvidenceLeaf>): boolean {
  const root = `visual/${card.id}/`;
  return card.evidenceTypes.every((evidenceType) => {
    const suffix = evidenceArtifactSuffix[evidenceType];
    return leaves.some((leaf) => leaf.path.startsWith(root) && leaf.path.endsWith(suffix));
  });
}

function validatePromotion(
  promotion: EvidencePromotion,
  cards: ReadonlyArray<string>,
  leaves: ReadonlyArray<EvidenceLeaf>,
): void {
  if (promotion.capturedCardCount !== cards.length) {
    throw new Error("Promotion captured-card count does not match the sealed card list.");
  }
  if (
    promotion.status === "promotable" &&
    (promotion.client === "ios" || promotion.client === "android")
  ) {
    throw new Error(
      "Promotable mobile evidence requires a native driver contract that is not implemented.",
    );
  }
  const requiredSceneCards = APPEARANCE_SCENE_CATALOG.filter(
    (card) => card.status === "g0-baseline" && card.clients.includes(promotion.client),
  );
  const requiredCards = requiredSceneCards.map((card) => card.id).sort(compareCanonicalText);
  if (promotion.requiredCardCount !== requiredCards.length) {
    throw new Error("Promotion required-card count does not match the current scene catalog.");
  }
  if (promotion.status === "promotable") {
    if (
      promotion.smokeOnly ||
      promotion.reasons.length > 0 ||
      cards.some((card, index) => card !== requiredCards[index]) ||
      cards.length !== requiredCards.length ||
      promotion.requestedWorkload.coldLaunchesPerAppearance !==
        DEFAULT_WORKLOAD.coldLaunchesPerAppearance ||
      promotion.requestedWorkload.alternatingPairs !== DEFAULT_WORKLOAD.alternatingPairs ||
      promotion.requestedWorkload.switches !== DEFAULT_WORKLOAD.switches ||
      promotion.observedWorkload.coldLaunchesPerAppearance !==
        DEFAULT_WORKLOAD.coldLaunchesPerAppearance ||
      promotion.observedWorkload.alternatingPairs !== DEFAULT_WORKLOAD.alternatingPairs ||
      promotion.observedWorkload.switches !== DEFAULT_WORKLOAD.switches ||
      requiredSceneCards.some((card) => !hasCompleteCardEvidence(card, leaves)) ||
      !leaves.some((leaf) => leaf.path === "metrics/raw.json")
    ) {
      throw new Error("Promotable evidence must use the full workload and complete card matrix.");
    }
  } else if (promotion.reasons.length === 0) {
    throw new Error("Non-promotable and blocked evidence must seal at least one reason.");
  }
  if (
    promotion.status === "blocked" &&
    (cards.length > 0 ||
      promotion.observedWorkload.coldLaunchesPerAppearance !== 0 ||
      promotion.observedWorkload.alternatingPairs !== 0 ||
      promotion.observedWorkload.switches !== 0 ||
      !leaves.some((leaf) => leaf.path.startsWith("blockers/")))
  ) {
    throw new Error(
      "Blocked evidence cannot award cards or workload and must include a blocker leaf.",
    );
  }
}
function assertManifestBinding(
  manifestPath: string,
  runId: string,
  leaves: ReadonlyArray<EvidenceLeaf>,
): void {
  const runRoot = NodePath.dirname(NodePath.resolve(manifestPath));
  if (NodePath.basename(runRoot) !== runId)
    throw new Error(`Evidence manifest run id '${runId}' does not match its run directory.`);
  const manifestLeafPath = NodePath.relative(runRoot, NodePath.resolve(manifestPath))
    .split(NodePath.sep)
    .join("/");
  if (leaves.some((leaf) => leaf.path === manifestLeafPath))
    throw new Error("Evidence manifest cannot list itself as a leaf.");
}
async function verifyEvidenceLeaves(
  runRoot: string,
  leaves: ReadonlyArray<EvidenceLeaf>,
): Promise<void> {
  const realRunRoot = await NodeFSP.realpath(runRoot);
  for (const leaf of leaves) {
    const candidate = NodePath.resolve(runRoot, leaf.path);
    if (!contained(candidate, runRoot))
      throw new Error(`Evidence leaf escapes run root: ${leaf.path}.`);
    const realCandidate = await NodeFSP.realpath(candidate);
    if (!contained(realCandidate, realRunRoot))
      throw new Error(`Evidence leaf escapes run root: ${leaf.path}.`);
    const bytes = await NodeFSP.readFile(realCandidate);
    if (hashEvidenceLeaf(leaf.path, bytes).sha256 !== leaf.sha256)
      throw new Error(`Evidence leaf hash mismatch: ${leaf.path}.`);
  }
}
export async function sealEvidenceManifest(
  path: string,
  manifest: Omit<EvidenceManifest, "manifestHash">,
): Promise<string> {
  if (!NodePath.isAbsolute(path)) throw new Error("Evidence manifest path must be absolute.");
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({
      schemaVersion: Schema.Literal(EVIDENCE_SCHEMA_VERSION),
      runId: NonEmpty,
      artifactIdentity: ArtifactIdentitySchema,
      runtimeIdentity: RuntimeIdentitySchema,
      commandIdentitySha256: Sha256,
      seedManifestSha256: Sha256,
      cards: Schema.Array(NonEmpty),
      promotion: EvidencePromotionSchema,
      leaves: Schema.Array(EvidenceLeafSchema),
    }),
  )(manifest);
  validateCardList(decoded.cards);
  validateLeafList(decoded.leaves);
  assertManifestBinding(path, decoded.runId, decoded.leaves);
  await verifyEvidenceLeaves(NodePath.dirname(path), decoded.leaves);
  const manifestHash = sha256Hex(canonicalJson(decoded));
  validatePromotion(decoded.promotion, decoded.cards, decoded.leaves);
  const sealed: EvidenceManifest = { ...decoded, manifestHash };
  const temporaryPath = `${path}.tmp-${NodeProcess.pid}-${NodeCrypto.randomUUID()}`;
  try {
    const handle = await NodeFSP.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(sealed, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.link(temporaryPath, path);
    await NodeFSP.unlink(temporaryPath);
    return manifestHash;
  } catch (error) {
    await NodeFSP.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
export async function validateSealedManifest(manifestPath: string): Promise<EvidenceManifest> {
  if (!NodePath.isAbsolute(manifestPath))
    throw new Error("Evidence manifest path must be absolute.");
  const absoluteManifestPath = NodePath.resolve(manifestPath);
  const manifestRoot = NodePath.dirname(absoluteManifestPath);
  const realManifestRoot = await NodeFSP.realpath(manifestRoot);
  const realManifest = await NodeFSP.realpath(absoluteManifestPath);
  if (!contained(realManifest, realManifestRoot))
    throw new Error("Manifest path escapes its run root.");
  const parsed: unknown = JSON.parse(await NodeFSP.readFile(realManifest, "utf8"));
  const manifest = Schema.decodeUnknownSync(EvidenceManifestSchema)(parsed);
  const { manifestHash, ...content } = manifest;
  if (sha256Hex(canonicalJson(content)) !== manifestHash)
    throw new Error("Evidence manifest hash does not match sealed content.");
  validateCardList(manifest.cards);
  validateLeafList(manifest.leaves);
  assertManifestBinding(absoluteManifestPath, manifest.runId, manifest.leaves);
  await verifyEvidenceLeaves(manifestRoot, manifest.leaves);
  validatePromotion(manifest.promotion, manifest.cards, manifest.leaves);
  return manifest;
}
export interface AppearanceEvidencePlan {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  readonly catalog: SceneCatalog;
  readonly rows: ReadonlyArray<ScenePlanRow>;
  readonly blockedExternal: ReadonlyArray<SceneCard>;
}
export function createAppearanceEvidencePlan(
  availableClients?: ReadonlySet<SceneClient>,
): AppearanceEvidencePlan {
  const planned = planAppearanceCatalog(APPEARANCE_SCENE_CATALOG, availableClients);
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    catalog: { schemaVersion: EVIDENCE_SCHEMA_VERSION, cards: planned.cards },
    rows: planned.rows,
    blockedExternal: planned.blockedExternal,
  };
}

export const APPROVAL_ID = "user-runtime-permission-2026-09-01" as const;
export const DEFAULT_WORKLOAD = {
  coldLaunchesPerAppearance: 5,
  alternatingPairs: 10,
  switches: 20,
} as const;
export interface AppearanceEvidenceCliArgs {
  readonly command: "plan" | "validate" | "capture" | "measure";
  readonly path?: string;
  readonly output?: string;
  readonly client?: "web" | "desktop";
  readonly approvalId?: string;
  readonly chromiumExecutable?: string;
  readonly baseRevision?: string;
  readonly contractIdentitySha256?: string;
  readonly disposableDevice: boolean;
  readonly smokeOnly: boolean;
  readonly coldCount: number;
  readonly pairCount: number;
}
function parseOptionValue(args: ReadonlyArray<string>, index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
export function parseAppearanceEvidenceArgs(
  args: ReadonlyArray<string>,
): AppearanceEvidenceCliArgs {
  const command = args[0];
  if (command === "plan" && args.length === 1) {
    return {
      command,
      disposableDevice: false,
      smokeOnly: false,
      coldCount: DEFAULT_WORKLOAD.coldLaunchesPerAppearance,
      pairCount: DEFAULT_WORKLOAD.alternatingPairs,
    };
  }
  if (command === "validate" && args.length === 2 && args[1]) {
    return {
      command,
      path: args[1],
      disposableDevice: false,
      smokeOnly: false,
      coldCount: DEFAULT_WORKLOAD.coldLaunchesPerAppearance,
      pairCount: DEFAULT_WORKLOAD.alternatingPairs,
    };
  }
  if (command !== "capture" && command !== "measure") {
    throw new Error(
      "Usage: appearance-evidence plan | validate <sealed-manifest.json> | capture|measure --client web|desktop --output /absolute/path --approval-id user-runtime-permission-2026-09-01 --disposable-device --base-revision <commit> --contract-identity-sha256 <sha256> [--chromium-executable /absolute/chromium] [--smoke-only].",
    );
  }
  let client: "web" | "desktop" | undefined;
  let output: string | undefined;
  let approvalId: string | undefined;
  let chromiumExecutable: string | undefined;
  let baseRevision: string | undefined;
  let contractIdentitySha256: string | undefined;
  let disposableDevice = false;
  let smokeOnly = false;
  let coldCount: number = DEFAULT_WORKLOAD.coldLaunchesPerAppearance;
  let pairCount: number = DEFAULT_WORKLOAD.alternatingPairs;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--disposable-device") {
      if (disposableDevice) throw new Error("Duplicate --disposable-device flag.");
      disposableDevice = true;
      continue;
    }
    if (flag === "--smoke-only") {
      if (smokeOnly) throw new Error("Duplicate --smoke-only flag.");
      smokeOnly = true;
      continue;
    }
    if (
      flag !== "--client" &&
      flag !== "--output" &&
      flag !== "--approval-id" &&
      flag !== "--chromium-executable" &&
      flag !== "--base-revision" &&
      flag !== "--contract-identity-sha256" &&
      flag !== "--cold-count" &&
      flag !== "--pair-count"
    ) {
      throw new Error(`Unknown or misplaced flag '${flag}'.`);
    }
    const value = parseOptionValue(args, index, flag);
    index += 1;
    if (flag === "--client") {
      if (client) throw new Error("Duplicate --client flag.");
      if (value !== "web" && value !== "desktop") {
        throw new Error("--client must be exactly web or desktop.");
      }
      client = value;
    } else if (flag === "--output") {
      if (output) throw new Error("Duplicate --output flag.");
      output = value;
    } else if (flag === "--approval-id") {
      if (approvalId) throw new Error("Duplicate --approval-id flag.");
      approvalId = value;
    } else if (flag === "--chromium-executable") {
      if (chromiumExecutable) throw new Error("Duplicate --chromium-executable flag.");
      chromiumExecutable = value;
    } else if (flag === "--base-revision") {
      if (baseRevision) throw new Error("Duplicate --base-revision flag.");
      baseRevision = value;
    } else if (flag === "--contract-identity-sha256") {
      if (contractIdentitySha256) {
        throw new Error("Duplicate --contract-identity-sha256 flag.");
      }
      contractIdentitySha256 = value;
    } else {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`${flag} must be a positive integer.`);
      }
      if (flag === "--cold-count") coldCount = count;
      else pairCount = count;
    }
  }
  if (!client || !output || !approvalId || !baseRevision || !contractIdentitySha256) {
    throw new Error(
      `${command} requires --client, absolute --output, --approval-id, --base-revision, and --contract-identity-sha256.`,
    );
  }
  if (!disposableDevice) {
    throw new Error(`${command} requires --disposable-device before any client is launched.`);
  }
  if (approvalId !== APPROVAL_ID) {
    throw new Error(`Approval id is not accepted; expected ${APPROVAL_ID}.`);
  }
  if (contractIdentitySha256 !== APPEARANCE_CONTRACT_IDENTITY_SHA256) {
    throw new Error(
      `--contract-identity-sha256 must match the reviewed appearance contract ${APPEARANCE_CONTRACT_IDENTITY_SHA256}.`,
    );
  }
  if (!NodePath.isAbsolute(output)) throw new Error("Evidence output root must be absolute.");
  if (
    command === "capture" &&
    (coldCount !== DEFAULT_WORKLOAD.coldLaunchesPerAppearance ||
      pairCount !== DEFAULT_WORKLOAD.alternatingPairs)
  ) {
    throw new Error("Count overrides are only valid for measure.");
  }
  if (
    (coldCount !== DEFAULT_WORKLOAD.coldLaunchesPerAppearance ||
      pairCount !== DEFAULT_WORKLOAD.alternatingPairs) &&
    !smokeOnly
  ) {
    throw new Error("Reduced workload counts require --smoke-only.");
  }
  if (client === "web" && (!chromiumExecutable || !NodePath.isAbsolute(chromiumExecutable))) {
    throw new Error("Web capture and measure require an absolute --chromium-executable.");
  }
  if (client === "desktop" && chromiumExecutable) {
    throw new Error("--chromium-executable is only valid for web.");
  }
  return {
    command,
    output,
    client,
    approvalId,
    ...(chromiumExecutable === undefined ? {} : { chromiumExecutable }),
    baseRevision,
    contractIdentitySha256,
    disposableDevice,
    smokeOnly,
    coldCount,
    pairCount,
  };
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function blockUnavailableDriverCapabilities(
  driver: AppearanceDriverResult,
): AppearanceDriverResult {
  if (driver.status !== "complete" || driver.capabilities.length === 0) return driver;
  const missingCapabilities = [...driver.capabilities].sort(compareCanonicalText);
  return {
    status: "blocked",
    client: driver.client,
    cards: [],
    samples: [],
    artifacts: [
      {
        path: "blockers/driver-capability-unavailable.json",
        content: jsonText({
          schemaVersion: 1,
          code: "driver-capability-unavailable",
          classification: "BLOCKED_INFRASTRUCTURE",
          missingCapabilities,
          runtimeVersion: driver.runtimeVersion,
        }),
      },
    ],
    capabilities: [],
    blockers: ["driver-capability-unavailable"],
    observedWorkload: {
      coldLaunchesPerAppearance: 0,
      alternatingPairs: 0,
      switches: 0,
    },
    runtimeVersion: driver.runtimeVersion,
  };
}
async function writeArtifact(runRoot: string, artifact: DriverArtifact): Promise<EvidenceLeaf> {
  if (NodePath.isAbsolute(artifact.path) || artifact.path.includes(".."))
    throw new Error(`Invalid evidence artifact path '${artifact.path}'.`);
  const absolute = NodePath.join(runRoot, artifact.path);
  await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true, mode: 0o700 });
  const handle = await NodeFSP.open(absolute, "wx", 0o600);
  try {
    await handle.writeFile(artifact.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hashEvidenceLeaf(artifact.path, artifact.content);
}
async function hostArtifactIdentity(
  baseRevision: string,
  contractIdentitySha256: string,
): Promise<ArtifactIdentity> {
  if (contractIdentitySha256 !== APPEARANCE_CONTRACT_IDENTITY_SHA256) {
    throw new Error("Artifact identity is not bound to the reviewed appearance contract.");
  }
  const baseCommit = (
    await commandOutput("git", ["rev-parse", "--verify", `${baseRevision}^{commit}`])
  ).trim();
  const diff = await commandOutput("git", ["diff", "--binary", baseCommit, "--"]);
  const untrackedPaths = (
    await commandOutput("git", ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter((path) => path.length > 0)
    .sort(compareCanonicalText);
  const checkoutRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
  );
  const untrackedFiles = await Promise.all(
    untrackedPaths.map(async (path) => ({
      path,
      sha256: sha256Hex(await NodeFSP.readFile(NodePath.join(checkoutRoot, path))),
    })),
  );
  return createArtifactIdentity({
    baseCommit,
    trackedDiffSha256: sha256Hex(diff),
    untrackedProductManifestSha256:
      untrackedFiles.length === 0 ? null : hashProductInputs(untrackedFiles),
    contractIdentitySha256,
  });
}
async function runApproved(parsed: AppearanceEvidenceCliArgs): Promise<string> {
  if (
    !parsed.output ||
    !parsed.client ||
    !parsed.approvalId ||
    !parsed.baseRevision ||
    !parsed.contractIdentitySha256
  ) {
    throw new Error("Approved evidence arguments were not fully parsed.");
  }
  const checkoutRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
  );
  const outputRoot = assertEvidenceOutputRoot({
    outputRoot: parsed.output,
    checkoutRoot,
    resolvedGitDir: NodePath.join(checkoutRoot, ".git"),
    t3Homes: [
      NodePath.join(NodeProcess.env.HOME ?? NodeOS.tmpdir(), ".t3"),
      NodePath.join(checkoutRoot, ".t3"),
    ],
  });
  const identity = await hostArtifactIdentity(parsed.baseRevision, parsed.contractIdentitySha256);
  await NodeFSP.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const runId = NodeCrypto.randomUUID();
  const runRoot = await createEvidenceRunDirectory(outputRoot, runId);
  try {
    const commandContent = jsonText({
      command: parsed.command,
      client: parsed.client,
      output: outputRoot,
      approvalId: parsed.approvalId,
      disposableDevice: parsed.disposableDevice,
      smokeOnly: parsed.smokeOnly,
      coldCount: parsed.coldCount,
      pairCount: parsed.pairCount,
      chromiumExecutable: parsed.chromiumExecutable ?? null,
      baseRevision: parsed.baseRevision,
      contractBinding: {
        source: "appearance-customization-playbook-semantic-contract",
        sha256: APPEARANCE_CONTRACT_IDENTITY_SHA256,
      },
    });
    const seedContent = jsonText({
      schemaVersion: 1,
      client: parsed.client,
      state: "disposable",
      source: "actual-surface-environment",
      seed: "empty-workspace-with-owned-t3-home",
    });
    const leaves: EvidenceLeaf[] = [
      await writeArtifact(runRoot, { path: "identity/command.json", content: commandContent }),
      await writeArtifact(runRoot, { path: "identity/seed.json", content: seedContent }),
    ];
    let driver =
      parsed.client === "web"
        ? await runWebAppearanceDriver({
            chromiumExecutable: parsed.chromiumExecutable!,
            measure: parsed.command === "measure",
            coldCount: parsed.coldCount,
            pairCount: parsed.pairCount,
          })
        : await runDesktopAppearanceDriver({
            measure: parsed.command === "measure",
            coldCount: parsed.coldCount,
            pairCount: parsed.pairCount,
          });
    driver = blockUnavailableDriverCapabilities(driver);
    for (const artifact of driver.artifacts) {
      leaves.push(await writeArtifact(runRoot, artifact));
    }
    const rawSamples = jsonText(driver.samples);
    const summaries = jsonText(aggregateMetricSamples(driver.samples));
    leaves.push(
      await writeArtifact(runRoot, { path: "metrics/raw.json", content: rawSamples }),
      await writeArtifact(runRoot, { path: "metrics/summary.json", content: summaries }),
    );
    const requiredCards = APPEARANCE_SCENE_CATALOG.filter(
      (card) =>
        card.status === "g0-baseline" && card.clients.includes(parsed.client as SceneClient),
    )
      .map((card) => card.id)
      .sort(compareCanonicalText);
    const capturedCards = [...driver.cards].sort(compareCanonicalText);
    const capturedCardSet = new Set(capturedCards);
    const missingCards = requiredCards.filter((card) => !capturedCardSet.has(card));
    const promotionReasons = [
      ...driver.blockers,
      ...(parsed.command === "capture" ? ["capture-only workload"] : []),
      ...(parsed.smokeOnly ? ["smoke-only reduced workload"] : []),
      ...(missingCards.length > 0
        ? [`incomplete scene matrix: ${missingCards.length} required cards missing`]
        : []),
    ];
    const promotion: EvidencePromotion = {
      status:
        driver.status === "blocked"
          ? "blocked"
          : promotionReasons.length > 0
            ? "non-promotable"
            : "promotable",
      client: parsed.client,
      smokeOnly: parsed.smokeOnly,
      requestedWorkload: {
        coldLaunchesPerAppearance: parsed.coldCount,
        alternatingPairs: parsed.pairCount,
        switches: parsed.pairCount * 2,
      },
      observedWorkload: driver.observedWorkload,
      requiredCardCount: requiredCards.length,
      capturedCardCount: capturedCards.length,
      reasons: promotionReasons,
    };
    leaves.sort((left, right) => compareCanonicalText(left.path, right.path));
    const manifestPath = NodePath.join(runRoot, "manifest.json");
    const manifestHash = await sealEvidenceManifest(manifestPath, {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId,
      artifactIdentity: identity,
      runtimeIdentity: createRuntimeIdentity({
        server: `t3-server@${identity.trackedDiffSha256}`,
        tool: "appearance-evidence/v2",
        browser: parsed.client === "web" ? driver.runtimeVersion : null,
        electron: parsed.client === "desktop" ? driver.runtimeVersion : null,
      }),
      promotion,
      commandIdentitySha256: sha256Hex(commandContent),
      seedManifestSha256: sha256Hex(seedContent),
      cards: capturedCards,
      leaves,
    });
    return `${manifestPath}\nmanifest-sha256=${manifestHash}\n${promotion.status.toUpperCase()}: ${promotion.reasons.join("; ") || "complete current matrix"}`;
  } catch (error) {
    await NodeFSP.rm(runRoot, { recursive: true, force: true });
    throw error;
  }
}
async function main(): Promise<void> {
  const parsed = parseAppearanceEvidenceArgs(NodeProcess.argv.slice(2));
  if (parsed.command === "plan") {
    NodeProcess.stdout.write(`${JSON.stringify(createAppearanceEvidencePlan(), null, 2)}\n`);
    return;
  }
  if (parsed.command === "validate") {
    const manifest = await validateSealedManifest(parsed.path ?? "");
    NodeProcess.stdout.write(
      `${JSON.stringify({
        status: manifest.promotion.status,
        manifest: NodePath.resolve(parsed.path ?? ""),
        reasons: manifest.promotion.reasons,
      })}\n`,
    );
    return;
  }
  NodeProcess.stdout.write(`${await runApproved(parsed)}\n`);
}
if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    NodeProcess.exit(1);
  });
}
export { validateSceneCatalog };
