// @effect-diagnostics nodeBuiltinImport:off - Evidence tests exercise real temporary filesystem boundaries.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  APPEARANCE_SCENE_CATALOG,
  EVIDENCE_SCHEMA_VERSION,
  REQUIRED_SCENE_IDS,
  validateSceneCatalog,
  type SceneCard,
  type SceneClient,
} from "./appearance-evidence.config.ts";
import {
  APPEARANCE_CONTRACT_IDENTITY_SHA256,
  aggregateMetricSamples,
  blockUnavailableDriverCapabilities,
  assertEvidenceOutputRoot,
  assertEvidenceRunDirectoryAvailable,
  canonicalJson,
  createAppearanceEvidencePlan,
  createArtifactIdentity,
  createEvidenceChildEnv,
  createEvidenceRunDirectory,
  createRuntimeIdentity,
  hashEvidenceLeaf,
  hashProductInputs,
  parseAppearanceEvidenceArgs,
  redactEvidenceText,
  redactEvidenceUrl,
  sealEvidenceManifest,
  validateSealedManifest,
  type EvidenceLeaf,
} from "./appearance-evidence.ts";
import {
  metricDelta,
  stylesheetMetricsFromProbe,
  type StylesheetProbe,
} from "./appearance-evidence-playwright.ts";

const EXPECTED_SCENE_IDS = `
workspace-empty sidebar-populated names-long badges hover selected drag collapsed
task-new composer-existing-thread autocomplete attachments mode-plan mode-default turn-pending turn-running
markdown-headings markdown-tables markdown-quotes markdown-links code-inline code-fenced streaming tool-calls approvals checkpoints errors
diff-split diff-unified additions deletions comments files-collapsed lines-long file-tree preview-image preview-text
terminal-ansi-palette terminal-selection terminal-cursor terminal-search terminal-resize tabs-multiple disconnected reconnect
settings-theme-library settings-editor settings-snippets settings-diagnostics settings-import settings-compatibility settings-quarantine settings-reset
command-palette context-menu popover tooltip toast dialog auth pairing offline update fatal-error
preview-chrome annotation
typography-minimum typography-maximum density-minimum density-maximum
appearance-light appearance-dark contrast-high motion-reduced
theme-built-in theme-v1-migrated package-manifest-only package-css package-font snippets-multiple snippet-broken mode-safe
desktop-macos desktop-windows desktop-linux browser-hosted browser-local ios android
`
  .trim()
  .split(/\s+/u);
const EXPECTED_FINAL_ONLY_IDS = [
  "mode-safe",
  "package-css",
  "package-font",
  "package-manifest-only",
  "settings-compatibility",
  "settings-diagnostics",
  "settings-quarantine",
  "settings-reset",
  "settings-snippets",
  "snippet-broken",
  "snippets-multiple",
  "theme-v1-migrated",
].sort();
const ALL_CLIENTS: ReadonlyArray<SceneClient> = ["web", "desktop", "ios", "android"];
const identity = createArtifactIdentity({
  baseCommit: "b5f2523",
  trackedDiffSha256: "a".repeat(64),
  untrackedProductManifestSha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  contractIdentitySha256: "c".repeat(64),
});

function requireCard(id: string): SceneCard {
  const card = APPEARANCE_SCENE_CATALOG.find((candidate) => candidate.id === id);
  if (!card) throw new Error(`Missing test scene '${id}'.`);
  return card;
}

async function rejection(effect: () => Promise<unknown>): Promise<Error> {
  try {
    await effect();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected promise to reject.");
}

function manifestFor(leaves: ReadonlyArray<EvidenceLeaf>, cards: ReadonlyArray<string> = ["card"]) {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: "run",
    artifactIdentity: identity,
    runtimeIdentity: {
      node: "v24",
      platform: "darwin",
      architecture: "arm64",
      server: "test-server",
      tool: "test-runner",
      browser: null,
      electron: null,
      mobile: null,
    },
    promotion: {
      status: "non-promotable" as const,
      client: "web" as const,
      smokeOnly: false,
      requestedWorkload: {
        coldLaunchesPerAppearance: 5,
        alternatingPairs: 10,
        switches: 20,
      },
      observedWorkload: {
        coldLaunchesPerAppearance: 0,
        alternatingPairs: 0,
        switches: 0,
      },
      requiredCardCount: APPEARANCE_SCENE_CATALOG.filter(
        (card) => card.status === "g0-baseline" && card.clients.includes("web"),
      ).length,
      capturedCardCount: cards.length,
      reasons: ["test fixture"],
    },
    commandIdentitySha256: "d".repeat(64),
    seedManifestSha256: "e".repeat(64),
    cards,
    leaves,
  };
}

it("encodes the exact required visual grammar with complete client declarations", () => {
  assert.equal(EXPECTED_SCENE_IDS.length, 89);
  assert.deepStrictEqual([...REQUIRED_SCENE_IDS], EXPECTED_SCENE_IDS);
  assert.deepStrictEqual(
    APPEARANCE_SCENE_CATALOG.map((card) => card.id),
    EXPECTED_SCENE_IDS,
  );
  assert.deepStrictEqual(
    APPEARANCE_SCENE_CATALOG.filter((card) => card.status === "final-only")
      .map((card) => card.id)
      .sort(),
    EXPECTED_FINAL_ONLY_IDS,
  );

  for (const card of APPEARANCE_SCENE_CATALOG) {
    assert.deepStrictEqual(
      [...card.clients, ...card.excludedClients].sort(),
      [...ALL_CLIENTS].sort(),
      `${card.id} does not partition the client set`,
    );
    assert.equal(new Set([...card.clients, ...card.excludedClients]).size, ALL_CLIENTS.length);
    assert.equal(card.evidenceTypes.includes("screenshot"), true);
    assert.equal(card.evidenceTypes.includes("accessibility"), true);
    assert.equal(card.readyGuard, `appearance.scene.${card.id}.ready`);
    assert.equal(card.driverKey, `appearance.${card.id}`);
  }

  assert.deepStrictEqual(requireCard("preview-chrome").clients, ["web", "desktop"]);
  assert.deepStrictEqual(requireCard("annotation").clients, ["web", "desktop"]);
  assert.deepStrictEqual(requireCard("browser-hosted").clients, ["web"]);
  assert.deepStrictEqual(requireCard("desktop-macos").clients, ["desktop"]);
  assert.deepStrictEqual(requireCard("ios").clients, ["ios"]);
  assert.deepStrictEqual(requireCard("android").clients, ["android"]);

  const first = APPEARANCE_SCENE_CATALOG[0];
  const second = APPEARANCE_SCENE_CATALOG[1];
  if (!first || !second) throw new Error("Scene fixture must contain at least two cards.");
  assert.throws(
    () => validateSceneCatalog([...APPEARANCE_SCENE_CATALOG, { ...first, id: second.id }]),
    /Duplicate scene card id/u,
  );
  const firstClient = first.clients[0];
  if (!firstClient) throw new Error("First scene fixture must have an applicable client.");
  const firstEvidenceType = first.evidenceTypes[0];
  if (!firstEvidenceType) throw new Error("First scene fixture must have an evidence type.");
  assert.throws(
    () =>
      validateSceneCatalog(
        APPEARANCE_SCENE_CATALOG.map((card) =>
          card.id === first.id ? { ...card, clients: [...card.clients, firstClient] } : card,
        ),
      ),
    /applicable or excluded exactly once/u,
  );
  assert.throws(
    () =>
      validateSceneCatalog(
        APPEARANCE_SCENE_CATALOG.map((card) =>
          card.id === first.id
            ? { ...card, evidenceTypes: [...card.evidenceTypes, firstEvidenceType] }
            : card,
        ),
      ),
    /unique screenshot and accessibility evidence/u,
  );
});

it("plans every applicable row as ready, blocked-product, or blocked-external", () => {
  const available = new Set<SceneClient>(["web", "desktop"]);
  const plan = createAppearanceEvidencePlan(available);
  assert.equal(
    plan.rows.length,
    APPEARANCE_SCENE_CATALOG.reduce((count, card) => count + card.clients.length, 0),
  );
  for (const card of plan.catalog.cards) {
    for (const client of ALL_CLIENTS) {
      const row = plan.rows.find(
        (candidate) => candidate.cardId === card.id && candidate.client === client,
      );
      if (card.excludedClients.includes(client)) {
        assert.equal(row, undefined, `${card.id}/${client} should be explicitly excluded`);
        continue;
      }
      if (!row) throw new Error(`Missing plan row ${card.id}/${client}.`);
      const expected =
        card.status === "final-only"
          ? "blocked-product"
          : available.has(client)
            ? "ready"
            : "blocked-external";
      assert.equal(row.status, expected, `${card.id}/${client}`);
    }
  }
  assert.equal(
    plan.blockedExternal.some((card) => card.id === "ios"),
    true,
  );
  assert.equal(
    plan.blockedExternal.some((card) => card.id === "android"),
    true,
  );
  assert.equal(
    plan.rows.some((row) => row.status === "blocked-product"),
    true,
  );
  const conservativePlan = createAppearanceEvidencePlan();
  assert.equal(
    conservativePlan.rows.some((row) => row.status === "ready"),
    false,
  );
  assert.equal(conservativePlan.blockedExternal.length > 0, true);
});

it("validates identity, metric units, duplicate samples, and aggregate statistics", () => {
  assert.equal(
    identity.untrackedProductManifestSha256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.deepStrictEqual(identity, createArtifactIdentity(identity));
  assert.equal(createRuntimeIdentity({ node: null }).node, null);
  const productFiles = [
    { path: "z/file.ts", sha256: "1".repeat(64) },
    { path: "ä/file.ts", sha256: "2".repeat(64) },
  ];
  const duplicateProductFile = productFiles[0];
  if (!duplicateProductFile) throw new Error("Product identity fixture must not be empty.");
  assert.equal(hashProductInputs(productFiles), hashProductInputs([...productFiles].reverse()));
  assert.throws(
    () => hashProductInputs([...productFiles, duplicateProductFile]),
    /Duplicate product input path/u,
  );
  assert.throws(
    () => hashProductInputs([{ path: "../escape", sha256: "1".repeat(64) }]),
    /Invalid product input path/u,
  );
  assert.throws(() => hashProductInputs([{ path: "file.ts", sha256: "not-a-hash" }]));
  assert.throws(() => canonicalJson(Number.NaN), /non-finite numbers/u);
  const warmSwitchSamples = Array.from({ length: 20 }, (_, index) => ({
    kind: "warm-switch" as const,
    client: "web" as const,
    appearance: "light" as const,
    value: index + 1,
    unit: "ms",
    sampleIndex: index,
  }));
  assert.deepStrictEqual(aggregateMetricSamples(warmSwitchSamples), [
    {
      kind: "warm-switch",
      client: "web",
      appearance: "light",
      unit: "ms",
      count: 20,
      median: 10.5,
      p95: 19,
      max: 20,
    },
  ]);
  const orderedGroups = aggregateMetricSamples([
    {
      kind: "stylesheet-count",
      client: "web",
      appearance: "light",
      value: 1,
      unit: "count",
      sampleIndex: 0,
    },
    {
      kind: "react-commits",
      client: "web",
      appearance: "light",
      value: 1,
      unit: "count",
      sampleIndex: 0,
    },
    {
      kind: "memory",
      client: "desktop",
      appearance: "light",
      value: 1,
      unit: "bytes",
      sampleIndex: 0,
    },
    {
      kind: "long-task",
      client: "web",
      appearance: "light",
      value: 1,
      unit: "ms",
      sampleIndex: 0,
    },
    {
      kind: "cold-startup",
      client: "desktop",
      appearance: "light",
      value: 1,
      unit: "ms",
      sampleIndex: 0,
    },
    {
      kind: "compiler",
      client: "web",
      appearance: "light",
      value: 1,
      unit: "ms",
      sampleIndex: 0,
    },
    {
      kind: "stylesheet-replacement",
      client: "web",
      appearance: "light",
      value: 1,
      unit: "ms",
      sampleIndex: 0,
    },
  ]);
  assert.deepStrictEqual(
    orderedGroups.map((summary) => summary.kind),
    [
      "cold-startup",
      "compiler",
      "long-task",
      "memory",
      "react-commits",
      "stylesheet-count",
      "stylesheet-replacement",
    ],
  );
  assert.throws(
    () =>
      aggregateMetricSamples([
        {
          kind: "memory",
          client: "desktop",
          appearance: "light",
          value: 1,
          unit: "ms",
          sampleIndex: 0,
        },
      ]),
    /requires unit bytes/u,
  );
  assert.throws(() =>
    aggregateMetricSamples([
      {
        kind: "warm-switch",
        client: "web",
        appearance: "light",
        value: 1,
        unit: "ms",
        sampleIndex: 0,
      },
      {
        kind: "warm-switch",
        client: "web",
        appearance: "light",
        value: 2,
        unit: "ms",
        sampleIndex: 0,
      },
    ]),
  );
  assert.throws(() =>
    aggregateMetricSamples([
      {
        kind: "warm-switch",
        client: "web",
        appearance: "light",
        value: -1,
        unit: "ms",
        sampleIndex: 0,
      },
    ]),
  );
  const stylesheetProbe = {
    records: [
      { kind: "document", href: "https://example.test/app.css", ruleCount: 3, readable: true },
      { kind: "managed-fallback", href: null, ruleCount: 2, readable: true },
      { kind: "adopted", href: null, ruleCount: 4, readable: true },
    ],
    hasDuplicateAdoptedSheet: false,
  } satisfies StylesheetProbe;
  const stylesheetMetrics = stylesheetMetricsFromProbe(stylesheetProbe);
  assert.deepStrictEqual(stylesheetMetrics, {
    ordinaryDocumentSheets: 2,
    adoptedConstructableSheets: 1,
    managedFallbackAppearanceStyles: 1,
    total: 3,
  });
  assert.equal(
    canonicalJson({ ...stylesheetMetrics }),
    '{"adoptedConstructableSheets":1,"managedFallbackAppearanceStyles":1,"ordinaryDocumentSheets":2,"total":3}',
  );
  assert.throws(
    () =>
      stylesheetMetricsFromProbe({
        ...stylesheetProbe,
        hasDuplicateAdoptedSheet: true,
      }),
    /Duplicate adopted appearance stylesheet cannot pass/u,
  );
  assert.throws(
    () =>
      stylesheetMetricsFromProbe({
        ...stylesheetProbe,
        records: [
          ...stylesheetProbe.records,
          { kind: "managed-fallback", href: null, ruleCount: 2, readable: true },
        ],
      }),
    /Multiple managed fallback appearance styles cannot pass/u,
  );
});

it("attributes renderer metrics by operation timestamps instead of observer delivery order", () => {
  const capabilities = {
    reactDevtools: { status: "available" as const },
    longTasks: { status: "available" as const },
  };
  const dropped = {
    reactCommits: 0,
    longTasks: 0,
    appearanceOperations: 0,
  };
  const before = {
    sampledAt: 100,
    reactCommits: [90],
    longTasks: [{ startTime: 90, duration: 99 }],
    appearanceOperations: [{ kind: "compile" as const, startTime: 90, duration: 99 }],
    capabilities,
    dropped,
  };
  const after = {
    sampledAt: 200,
    reactCommits: [90, 130, 170],
    longTasks: [
      { startTime: 90, duration: 99 },
      { startTime: 150, duration: 40 },
    ],
    appearanceOperations: [
      { kind: "compile" as const, startTime: 90, duration: 99 },
      { kind: "compile" as const, startTime: 120, duration: 3 },
      { kind: "stylesheet-replacement" as const, startTime: 140, duration: 2 },
    ],
    capabilities,
    dropped,
  };

  assert.deepStrictEqual(metricDelta(before, after), {
    reactCommits: 2,
    maxLongTaskDurationMs: 40,
    compileDurationMs: 3,
    stylesheetReplacementDurationMs: 2,
  });
});

it("allows only explicit toolchain environment keys and redacts evidence output", () => {
  const env = createEvidenceChildEnv({
    PATH: "/bin",
    HOME: "/tmp/home",
    ANDROID_HOME: "/tmp/android",
    ANDROID_SDK_ROOT: "/tmp/android",
    JAVA_HOME: "/tmp/jdk",
    DEVELOPER_DIR: "/tmp/xcode",
    API_TOKEN: "secret",
    OTHER: "nope",
  });
  assert.deepStrictEqual(env, {
    PATH: "/bin",
    HOME: "/tmp/home",
    ANDROID_HOME: "/tmp/android",
    ANDROID_SDK_ROOT: "/tmp/android",
    JAVA_HOME: "/tmp/jdk",
    DEVELOPER_DIR: "/tmp/xcode",
  });
  const secretOverride: Readonly<Record<string, string>> = { API_TOKEN: "secret" };
  const unknownOverride: Readonly<Record<string, string>> = { CUSTOM_PATH: "/tmp" };
  assert.throws(
    () => createEvidenceChildEnv({}, secretOverride),
    /Refusing secret or non-allowlisted/u,
  );
  assert.throws(
    () => createEvidenceChildEnv({}, unknownOverride),
    /Refusing secret or non-allowlisted/u,
  );
  assert.equal(
    redactEvidenceUrl("https://example.test/path?token=secret#fragment"),
    "https://example.test/path",
  );
  assert.equal(
    redactEvidenceText("token=secret password=hunter2 https://example.test/x?q=y literal-$&", [
      "secret",
      "hunter2",
      "$&",
    ]),
    "token=[REDACTED] password=[REDACTED] https://example.test/x literal-[REDACTED]",
  );
  assert.equal(
    redactEvidenceText("Authorization: Bearer abc.def ws=wss://example.test/socket?token=secret"),
    "Authorization: [REDACTED] ws=wss://example.test/socket",
  );
});

it("parses non-launching commands without runtime authority", () => {
  assert.deepStrictEqual(parseAppearanceEvidenceArgs(["plan"]), {
    command: "plan",
    disposableDevice: false,
    smokeOnly: false,
    coldCount: 5,
    pairCount: 10,
  });
  assert.deepStrictEqual(parseAppearanceEvidenceArgs(["validate", "/tmp/manifest.json"]), {
    command: "validate",
    path: "/tmp/manifest.json",
    disposableDevice: false,
    smokeOnly: false,
    coldCount: 5,
    pairCount: 10,
  });
  assert.throws(() => parseAppearanceEvidenceArgs(["plan", "extra"]), /Usage/u);
  assert.throws(() => parseAppearanceEvidenceArgs(["validate"]), /Usage/u);
});

it("requires explicit approval, disposable state, identities, and smoke labeling", () => {
  const contractIdentity = APPEARANCE_CONTRACT_IDENTITY_SHA256;
  const baseArgs = [
    "measure",
    "--client",
    "web",
    "--output",
    "/tmp/evidence",
    "--approval-id",
    "user-runtime-permission-2026-09-01",
    "--disposable-device",
    "--base-revision",
    "base",
    "--contract-identity-sha256",
    contractIdentity,
    "--chromium-executable",
    "/Applications/Chromium",
  ] as const;
  assert.deepStrictEqual(parseAppearanceEvidenceArgs(baseArgs), {
    command: "measure",
    output: "/tmp/evidence",
    client: "web",
    approvalId: "user-runtime-permission-2026-09-01",
    chromiumExecutable: "/Applications/Chromium",
    baseRevision: "base",
    contractIdentitySha256: contractIdentity,
    disposableDevice: true,
    smokeOnly: false,
    coldCount: 5,
    pairCount: 10,
  });
  const oldContractIdentity =
    "f474031d280c1b9cd95cdf6c731cef60044ebeffd062988d95eed3dc2095d8ea" as const;
  assert.equal(
    contractIdentity,
    "54ccbab26ba43af981f9326000c04c98641b961ea6211e814668e908c53caa08",
  );
  assert.throws(
    () =>
      parseAppearanceEvidenceArgs(
        baseArgs.map((arg) => (arg === contractIdentity ? oldContractIdentity : arg)),
      ),
    /must match the reviewed appearance contract/u,
  );
  assert.throws(
    () => parseAppearanceEvidenceArgs(baseArgs.filter((arg) => arg !== "--disposable-device")),
    /requires --disposable-device/u,
  );
  assert.throws(
    () => parseAppearanceEvidenceArgs([...baseArgs, "--cold-count", "1"]),
    /Reduced workload counts require --smoke-only/u,
  );
  assert.deepStrictEqual(
    parseAppearanceEvidenceArgs([
      ...baseArgs,
      "--smoke-only",
      "--cold-count",
      "1",
      "--pair-count",
      "1",
    ]),
    {
      command: "measure",
      output: "/tmp/evidence",
      client: "web",
      approvalId: "user-runtime-permission-2026-09-01",
      chromiumExecutable: "/Applications/Chromium",
      baseRevision: "base",
      contractIdentitySha256: contractIdentity,
      disposableDevice: true,
      smokeOnly: true,
      coldCount: 1,
      pairCount: 1,
    },
  );
});

it.effect("enforces output containment, symlink resolution, collision safety, and mode", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "appearance-output-test-"));
    try {
      const checkout = NodePath.join(root, "checkout");
      const gitDirectory = NodePath.join(root, "git");
      const t3Home = NodePath.join(root, "t3-home");
      const output = NodePath.join(root, "evidence");
      await Promise.all(
        [checkout, gitDirectory, t3Home, output].map((path) =>
          NodeFSP.mkdir(path, { recursive: true }),
        ),
      );
      assert.equal(
        assertEvidenceOutputRoot({
          outputRoot: output,
          checkoutRoot: checkout,
          resolvedGitDir: gitDirectory,
          t3Homes: [t3Home],
        }),
        await NodeFSP.realpath(output),
      );
      assert.throws(
        () =>
          assertEvidenceOutputRoot({
            outputRoot: "relative",
            checkoutRoot: checkout,
            resolvedGitDir: gitDirectory,
            t3Homes: [t3Home],
          }),
        /must be absolute/u,
      );
      assert.throws(
        () =>
          assertEvidenceOutputRoot({
            outputRoot: NodePath.join(checkout, "nested"),
            checkoutRoot: checkout,
            resolvedGitDir: gitDirectory,
            t3Homes: [t3Home],
          }),
        /overlaps a forbidden path/u,
      );
      assert.throws(
        () =>
          assertEvidenceOutputRoot({
            outputRoot: root,
            checkoutRoot: checkout,
            resolvedGitDir: gitDirectory,
            t3Homes: [t3Home],
          }),
        /overlaps a forbidden path/u,
      );
      assert.throws(
        () =>
          assertEvidenceOutputRoot({
            outputRoot: output,
            checkoutRoot: checkout,
            resolvedGitDir: gitDirectory,
            t3Homes: [t3Home],
            syntheticEnvironment: NodePath.join(output, "synthetic"),
          }),
        /overlaps a forbidden path/u,
      );

      if (HostProcessPlatform.defaultValue() !== "win32") {
        const linkedOutput = NodePath.join(root, "linked-output");
        await NodeFSP.symlink(checkout, linkedOutput, "dir");
        assert.throws(
          () =>
            assertEvidenceOutputRoot({
              outputRoot: linkedOutput,
              checkoutRoot: checkout,
              resolvedGitDir: gitDirectory,
              t3Homes: [t3Home],
            }),
          /overlaps a forbidden path/u,
        );
      }

      const runDirectory = NodePath.join(output, "run-1");
      await assertEvidenceRunDirectoryAvailable(runDirectory);
      assert.equal(
        await createEvidenceRunDirectory(output, "run-1"),
        NodePath.join(await NodeFSP.realpath(output), "run-1"),
      );
      assert.equal((await NodeFSP.stat(runDirectory)).mode & 0o777, 0o700);
      assert.match(
        (await rejection(() => assertEvidenceRunDirectoryAvailable(runDirectory))).message,
        /already exists/u,
      );
      assert.match(
        (await rejection(() => createEvidenceRunDirectory(output, "run-1"))).message,
        /EEXIST|exist/u,
      );
      assert.match(
        (await rejection(() => createEvidenceRunDirectory(output, "../escape"))).message,
        /Invalid evidence run id/u,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);

it.effect("seals sorted evidence leaves without overwrite and detects tampering", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "appearance-seal-test-"));
    try {
      const runDirectory = await createEvidenceRunDirectory(root, "run");
      const first = hashEvidenceLeaf("a.json", "alpha");
      const second = hashEvidenceLeaf("nested/b.json", "beta");
      await NodeFSP.mkdir(NodePath.join(runDirectory, "nested"));
      await NodeFSP.writeFile(NodePath.join(runDirectory, first.path), "alpha");
      await NodeFSP.writeFile(NodePath.join(runDirectory, second.path), "beta");
      const manifestPath = NodePath.join(runDirectory, "manifest.json");
      await sealEvidenceManifest(manifestPath, manifestFor([first, second], ["card-a", "card-b"]));
      const manifest = await validateSealedManifest(manifestPath);
      assert.deepStrictEqual(manifest.leaves, [first, second]);
      assert.match(manifest.manifestHash, /^[0-9a-f]{64}$/u);
      assert.equal(manifest.commandIdentitySha256, "d".repeat(64));
      assert.equal(manifest.seedManifestSha256, "e".repeat(64));
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(manifestPath, manifestFor([first, second], ["card-a", "card-b"])),
          )
        ).message,
        /EEXIST|exist/u,
      );

      await NodeFSP.writeFile(NodePath.join(runDirectory, first.path), "tampered");
      assert.match(
        (await rejection(() => validateSealedManifest(manifestPath))).message,
        /leaf hash mismatch/u,
      );
      await NodeFSP.writeFile(NodePath.join(runDirectory, first.path), "alpha");
      const sealedText = await NodeFSP.readFile(manifestPath, "utf8");
      await NodeFSP.writeFile(
        manifestPath,
        sealedText.replace('"runId": "run"', '"runId": "other"'),
      );
      assert.match(
        (await rejection(() => validateSealedManifest(manifestPath))).message,
        /manifest hash does not match/u,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);
it("converts unavailable measurement probes into a zero-workload typed blocker", () => {
  const blocked = blockUnavailableDriverCapabilities({
    status: "complete",
    client: "desktop",
    cards: ["appearance-light"],
    samples: [],
    artifacts: [],
    capabilities: ["memory: unavailable"],
    blockers: [],
    observedWorkload: {
      coldLaunchesPerAppearance: 5,
      alternatingPairs: 10,
      switches: 20,
    },
    runtimeVersion: "Electron test",
  });
  assert.equal(blocked.status, "blocked");
  assert.deepStrictEqual(blocked.cards, []);
  assert.deepStrictEqual(blocked.samples, []);
  assert.deepStrictEqual(blocked.observedWorkload, {
    coldLaunchesPerAppearance: 0,
    alternatingPairs: 0,
    switches: 0,
  });
  assert.equal(blocked.artifacts[0]?.path, "blockers/driver-capability-unavailable.json");
});

it.effect("rejects forged promotable and nonzero blocked evidence states", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "appearance-promotion-test-"),
    );
    try {
      const runDirectory = await createEvidenceRunDirectory(root, "run");
      const manifestPath = NodePath.join(runDirectory, "manifest.json");
      const base = manifestFor([], []);
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(manifestPath, {
              ...base,
              promotion: {
                ...base.promotion,
                status: "promotable",
                observedWorkload: {
                  coldLaunchesPerAppearance: 5,
                  alternatingPairs: 10,
                  switches: 20,
                },
                reasons: [],
              },
            }),
          )
        ).message,
        /full workload and complete card matrix/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(manifestPath, {
              ...base,
              promotion: {
                ...base.promotion,
                status: "promotable",
                client: "ios",
                reasons: [],
              },
            }),
          )
        ).message,
        /native driver contract/u,
      );
      const requiredCards = APPEARANCE_SCENE_CATALOG.filter(
        (card) => card.status === "g0-baseline" && card.clients.includes("web"),
      )
        .map((card) => card.id)
        .sort();
      await NodeFSP.mkdir(NodePath.join(runDirectory, "metrics"));
      await NodeFSP.mkdir(NodePath.join(runDirectory, "visual", "forged"), {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(runDirectory, "metrics", "raw.json"), "[]");
      await NodeFSP.writeFile(
        NodePath.join(runDirectory, "visual", "forged", "screenshot.png"),
        "one-image",
      );
      const forgedLeaves = [
        hashEvidenceLeaf("metrics/raw.json", "[]"),
        hashEvidenceLeaf("visual/forged/screenshot.png", "one-image"),
      ];
      const forgedBase = manifestFor(forgedLeaves, requiredCards);
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(manifestPath, {
              ...forgedBase,
              promotion: {
                ...forgedBase.promotion,
                status: "promotable",
                observedWorkload: {
                  coldLaunchesPerAppearance: 5,
                  alternatingPairs: 10,
                  switches: 20,
                },
                reasons: [],
              },
            }),
          )
        ).message,
        /full workload and complete card matrix/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(manifestPath, {
              ...base,
              promotion: {
                ...base.promotion,
                status: "blocked",
                observedWorkload: {
                  coldLaunchesPerAppearance: 0,
                  alternatingPairs: 1,
                  switches: 0,
                },
                reasons: ["typed blocker"],
              },
            }),
          )
        ).message,
        /cannot award cards or workload/u,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);

it.effect("rejects traversal, duplicate ordering, and symlink leaf escapes", () =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "appearance-leaf-test-"));
    try {
      const runDirectory = await createEvidenceRunDirectory(root, "run");
      await NodeFSP.writeFile(NodePath.join(runDirectory, "a.json"), "alpha");
      await NodeFSP.writeFile(NodePath.join(runDirectory, "b.json"), "beta");
      const first = hashEvidenceLeaf("a.json", "alpha");
      const second = hashEvidenceLeaf("b.json", "beta");
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(
              NodePath.join(runDirectory, "unsorted.json"),
              manifestFor([second, first]),
            ),
          )
        ).message,
        /leaves must be sorted/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(
              NodePath.join(runDirectory, "duplicate.json"),
              manifestFor([first, first]),
            ),
          )
        ).message,
        /Duplicate evidence leaf/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(
              NodePath.join(runDirectory, "traversal.json"),
              manifestFor([hashEvidenceLeaf("../outside.json", "outside")]),
            ),
          )
        ).message,
        /Invalid evidence leaf path/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(
              NodePath.join(runDirectory, "cards-unsorted.json"),
              manifestFor([first], ["card-b", "card-a"]),
            ),
          )
        ).message,
        /cards must be sorted/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(
              NodePath.join(runDirectory, "cards-duplicate.json"),
              manifestFor([first], ["card-a", "card-a"]),
            ),
          )
        ).message,
        /Duplicate evidence card/u,
      );
      await NodeFSP.writeFile(NodePath.join(runDirectory, "manifest-self.json"), "old manifest");
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(
              NodePath.join(runDirectory, "manifest-self.json"),
              manifestFor([hashEvidenceLeaf("manifest-self.json", "old manifest")]),
            ),
          )
        ).message,
        /cannot list itself as a leaf/u,
      );
      assert.match(
        (
          await rejection(() =>
            sealEvidenceManifest(NodePath.join(runDirectory, "mismatch.json"), {
              ...manifestFor([first]),
              runId: "other",
            }),
          )
        ).message,
        /does not match its run directory/u,
      );

      if (HostProcessPlatform.defaultValue() !== "win32") {
        const outside = NodePath.join(root, "outside.json");
        await NodeFSP.writeFile(outside, "outside");
        await NodeFSP.symlink(outside, NodePath.join(runDirectory, "escape.json"), "file");
        assert.match(
          (
            await rejection(() =>
              sealEvidenceManifest(
                NodePath.join(runDirectory, "symlink.json"),
                manifestFor([hashEvidenceLeaf("escape.json", "outside")]),
              ),
            )
          ).message,
          /escapes run root/u,
        );
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }),
);
