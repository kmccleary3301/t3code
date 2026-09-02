import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const { spawnSync } = NodeChildProcess;
const { createHash, randomUUID } = NodeCrypto;
const { createRequire } = NodeModule;
const fs = NodeFS.promises;
const net = NodeNet;
const path = NodePath;
const { pathToFileURL } = NodeURL;
const [repoRootArg, releaseRootArg, evidenceRootArg, productCommit, contractSha256] =
  NodeProcess.argv.slice(2);
if (!repoRootArg || !releaseRootArg || !evidenceRootArg || !productCommit || !contractSha256) {
  throw new Error(
    "Usage: node windows-appearance-smoke.mjs <repo-root> <release-root> <evidence-root> <commit> <contract-sha256>",
  );
}

const repoRoot = path.resolve(repoRootArg);
const releaseRoot = path.resolve(releaseRootArg);
const evidenceRoot = path.resolve(evidenceRootArg);
const t3HomeRoot = path.join(evidenceRoot, "t3home");
const stateRoot = path.join(t3HomeRoot, "t3code-pi-omp", "userdata");
const appDataRoot = path.join(evidenceRoot, "appdata");
const localAppDataRoot = path.join(evidenceRoot, "localappdata");
const userProfileRoot = path.join(evidenceRoot, "profile");
const temporaryRoot = path.join(evidenceRoot, "temp");
const electronUserDataRoot = path.join(evidenceRoot, "electron-user-data");
const packageId = "windows-evidence";
const packageName = "Windows Evidence Package";
const packageMarkerProperty = "--t3-windows-package-marker";
const snippetMarkerProperty = "--t3-windows-snippet-marker";
const packageFontFamily = "Evidence Symbols";
const expectedExecutableName = "T3 Code Pi + OMP (Alpha).exe";
const hostLocalAppData = NodeProcess.env.LOCALAPPDATA;
const assertions = [];
const consoleEntries = [];
const result = {
  schema: "t3.appearance.windows-evidence/v1",
  sourceCommit: productCommit,
  contractSha256,
  platform: NodeProcess.platform,
  architecture: NodeProcess.arch,
  runner: NodeProcess.env.RUNNER_NAME ?? null,
  installer: null,
  executable: null,
  assertions,
  states: {},
  persisted: {},
  console: consoleEntries,
};
let activeElectronApp = null;
let installedExecutable = null;

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertEvidence(condition, name, details) {
  const assertion = { name, passed: Boolean(condition), details };
  assertions.push(assertion);
  if (!condition) throw new Error(`Evidence assertion failed: ${name}`);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function walkExecutables(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) found.push(candidate);
    }
  }
  return found;
}

async function waitForInstalledExecutable(roots, installedAfter) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const candidates = [];
    for (const root of roots) candidates.push(...(await walkExecutables(root)));
    for (const candidate of candidates) {
      if (path.basename(candidate) !== expectedExecutableName) continue;
      const stat = await fs.stat(candidate);
      if (stat.mtimeMs >= installedAfter - 5_000) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Silent NSIS install did not produce ${expectedExecutableName} under ${roots.join(", ")}.`,
  );
}

function attachConsole(page, label) {
  page.on("console", (message) => {
    consoleEntries.push({ label, type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    consoleEntries.push({ label, type: "pageerror", text: error.stack ?? error.message });
  });
}

async function waitForApplication(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 120_000 });
  await page.waitForFunction(
    () => document.body !== null && document.body.innerText.trim().length > 0,
    undefined,
    { timeout: 120_000 },
  );
}

async function openAppearanceSettings(page) {
  await page.evaluate(() => {
    window.location.hash = "/settings/appearance";
  });
  await page.getByRole("region", { name: "Appearance customizations" }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

async function collectState(page, label) {
  await page.evaluate(() => document.fonts.ready);
  const observed = await page.evaluate(
    ({ packageMarkerProperty, snippetMarkerProperty, packageName, packageFontFamily }) => {
      const root = document.documentElement;
      const computed = getComputedStyle(root);
      const fontFaces = Array.from(document.fonts)
        .filter((face) => face.family.replaceAll('"', "") === packageFontFamily)
        .map((face) => ({ family: face.family, status: face.status, weight: face.weight }));
      return {
        url: window.location.href,
        title: document.title,
        dark: root.classList.contains("dark"),
        packageMarker: computed.getPropertyValue(packageMarkerProperty).trim(),
        snippetMarker: computed.getPropertyValue(snippetMarkerProperty).trim(),
        packageFontFaces: fontFaces,
        packageFontCheck: document.fonts.check(`16px "${packageFontFamily}"`),
        packageVisible: document.body.innerText.includes(packageName),
        recoveryVisible: document.body.innerText.includes("Appearance recovery mode"),
        resetVisible: document.body.innerText.includes("Reset all appearance customizations"),
        activePackageId: root.dataset.t3AppearancePackage ?? null,
        activeVariantId: root.dataset.t3AppearanceVariant ?? null,
      };
    },
    { packageMarkerProperty, snippetMarkerProperty, packageName, packageFontFamily },
  );
  await page.screenshot({ path: path.join(evidenceRoot, `${label}.png`), fullPage: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const accessibility = await cdp.send("Accessibility.getFullAXTree");
  await writeJson(path.join(evidenceRoot, `${label}-accessibility.json`), accessibility);
  result.states[label] = observed;
  await writeJson(path.join(evidenceRoot, "summary.partial.json"), result);
  return observed;
}

async function launchPackaged(electron, environment, label) {
  const electronApp = await electron.launch({
    executablePath: installedExecutable,
    args: ["--no-sandbox", "--disable-gpu", `--user-data-dir=${electronUserDataRoot}`],
    env: environment,
    timeout: 120_000,
  });
  activeElectronApp = electronApp;
  const page = await electronApp.firstWindow({ timeout: 120_000 });
  attachConsole(page, label);
  await waitForApplication(page);
  return { electronApp, page };
}

async function closePackaged(electronApp) {
  if (electronApp === null) return;
  const pid = electronApp.process()?.pid;
  try {
    await Promise.race([
      electronApp.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Electron close timed out.")), 20_000),
      ),
    ]);
  } catch (error) {
    if (pid !== undefined) {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
    throw error;
  } finally {
    activeElectronApp = null;
  }
}

function summarizeState(state) {
  return {
    revision: state.revision,
    packageIds: Object.keys(state.packages),
    enabledPackageIds: Object.values(state.packages)
      .filter((entry) => entry.enabled)
      .map((entry) => entry.profile.metadata.id),
    order: state.order,
    preference: state.preference,
    typographyPreference: state.typographyPreference ?? null,
    snippets: state.snippets.map(({ id, enabled, advanced, css }) => ({
      id,
      enabled,
      advanced,
      sha256: sha256Bytes(Buffer.from(css)),
    })),
    safeMode: state.safeMode,
    diagnostics: state.diagnostics,
    migration: state.migration,
  };
}

async function main() {
  assertEvidence(NodeProcess.platform === "win32", "Windows runner", {
    platform: NodeProcess.platform,
  });
  assertEvidence(NodeProcess.arch === "x64", "Windows x64 architecture", {
    architecture: NodeProcess.arch,
  });
  await fs.rm(evidenceRoot, { recursive: true, force: true });
  for (const directory of [
    evidenceRoot,
    stateRoot,
    appDataRoot,
    localAppDataRoot,
    userProfileRoot,
    temporaryRoot,
    electronUserDataRoot,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }

  const releaseEntries = await fs.readdir(releaseRoot, { withFileTypes: true });
  const installers = releaseEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
    .map((entry) => path.join(releaseRoot, entry.name));
  assertEvidence(installers.length === 1, "One NSIS installer", {
    installers: installers.map((entry) => path.basename(entry)),
  });
  const installerPath = installers[0];
  const installerBytes = await fs.readFile(installerPath);
  result.installer = {
    name: path.basename(installerPath),
    bytes: installerBytes.byteLength,
    sha256: sha256Bytes(installerBytes),
  };
  await writeJson(path.join(evidenceRoot, "artifact-identity.json"), {
    sourceCommit: productCommit,
    contractSha256,
    installer: result.installer,
  });

  const sharedAppearance = await import(
    pathToFileURL(path.join(repoRoot, "packages/shared/src/appearance/index.ts")).href
  );
  const { T3_CHAT_THEME } = await import(
    pathToFileURL(path.join(repoRoot, "packages/shared/src/themePalettes.ts")).href
  );
  const { DesktopAppearanceStorage } = await import(
    pathToFileURL(path.join(repoRoot, "apps/desktop/src/appearance/DesktopAppearanceStorage.ts"))
      .href
  );
  const normalized = sharedAppearance.normalizeAppearance(T3_CHAT_THEME, {
    sourceId: packageId,
    platform: "desktop-windows",
    appVersion: "0.0.37",
  });
  if (normalized.status === "failure") {
    throw new Error(`Could not normalize evidence profile: ${normalized.diagnostic.message}`);
  }

  const fontPath = path.join(
    repoRoot,
    "apps/web/src/terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2",
  );
  const fontBytes = await fs.readFile(fontPath);
  const desktopCss = `:root { ${packageMarkerProperty}: package-active; }\n`;
  const desktopCssBytes = Buffer.from(desktopCss);
  const fontAsset = {
    id: "evidence-font",
    kind: "font",
    path: "fonts/evidence.woff2",
    sha256: sha256Bytes(fontBytes),
    mimeType: "font/woff2",
    sizeBytes: fontBytes.byteLength,
    platforms: ["desktop-windows"],
    family: packageFontFamily,
    style: "normal",
    weight: 400,
  };
  const capabilities = Array.from(
    new Set([...normalized.profile.capabilities, "fonts", "desktop-css"]),
  );
  const manifest = {
    schema: sharedAppearance.APPEARANCE_SCHEMA_ID,
    version: sharedAppearance.APPEARANCE_MANIFEST_VERSION,
    metadata: {
      id: packageId,
      name: packageName,
      version: "1.0.0",
      description: "Disposable Windows packaged-runtime evidence package.",
      author: "T3 appearance verification",
    },
    compatibility: {
      platforms: ["desktop-windows"],
      requiredCapabilities: ["fonts", "desktop-css"],
    },
    capabilities,
    fallback: normalized.profile.fallback,
    defaultVariant: normalized.profile.defaultVariant,
    variants: normalized.profile.variants.map((variant) => ({
      ...variant,
      typography: {
        ...variant.typography,
        interface: {
          ...variant.typography.interface,
          families: [
            packageFontFamily,
            ...variant.typography.interface.families.filter(
              (family) => family !== packageFontFamily,
            ),
          ],
        },
      },
    })),
    assets: [fontAsset],
    styles: {
      desktop: {
        path: "desktop.css",
        sha256: sha256Bytes(desktopCssBytes),
        sizeBytes: desktopCssBytes.byteLength,
      },
    },
    presentation: normalized.profile.presentation,
  };

  const storage = new DesktopAppearanceStorage(stateRoot, "0.0.37", "win32");
  await storage.install({
    input: manifest,
    sourceId: packageId,
    trust: {
      class: "local-package",
      allowSharedCss: false,
      allowDesktopCss: true,
      allowAdvancedSnippet: false,
    },
    desktopCss,
    assets: [
      {
        id: fontAsset.id,
        path: fontAsset.path,
        sha256: fontAsset.sha256,
        mimeType: fontAsset.mimeType,
        sizeBytes: fontAsset.sizeBytes,
        dataBase64: fontBytes.toString("base64"),
      },
    ],
  });
  const installedState = await storage.load();
  const installedPackage = installedState.packages[packageId];
  assertEvidence(installedPackage !== undefined, "Evidence package installed", {
    packageId,
  });
  await storage.commit(installedState.revision, {
    ...installedState,
    revision: installedState.revision + 1,
    packages: {
      ...installedState.packages,
      [packageId]: { ...installedPackage, enabled: true },
    },
    preference: { mode: "dark", packageId },
    snippets: [
      {
        id: "windows-evidence-snippet",
        css: `:root { ${snippetMarkerProperty}: snippet-active; }`,
        enabled: true,
        advanced: false,
      },
    ],
    migration: { completed: true },
  });
  const activeState = await storage.load();
  await storage.reset();
  await storage.setSafeMode(true);
  const recoveryState = await storage.load();
  const quarantinedBeforeLaunch = await storage.readQuarantinedState();
  assertEvidence(recoveryState.safeMode, "Safe mode seeded", summarizeState(recoveryState));
  assertEvidence(
    quarantinedBeforeLaunch?.packages[packageId]?.enabled === true,
    "Recovery copy preserves enabled package",
    quarantinedBeforeLaunch === null ? null : summarizeState(quarantinedBeforeLaunch),
  );
  storage.close();

  const installStartedAt = Date.now();
  const installResult = spawnSync(installerPath, ["/S"], {
    encoding: "utf8",
    timeout: 240_000,
    windowsHide: true,
  });
  await fs.writeFile(path.join(evidenceRoot, "installer-stdout.log"), installResult.stdout ?? "");
  await fs.writeFile(path.join(evidenceRoot, "installer-stderr.log"), installResult.stderr ?? "");
  assertEvidence(installResult.error === undefined, "NSIS installer process completed", {
    error: installResult.error?.message ?? null,
  });
  assertEvidence(installResult.status === 0, "NSIS silent install exited successfully", {
    status: installResult.status,
    signal: installResult.signal,
  });

  const installationRoots = Array.from(
    new Set(
      [hostLocalAppData, NodeProcess.env.LOCALAPPDATA, localAppDataRoot]
        .filter((entry) => typeof entry === "string" && entry.length > 0)
        .map((entry) => path.join(entry, "Programs")),
    ),
  );
  installedExecutable = await waitForInstalledExecutable(installationRoots, installStartedAt);
  const executableStat = await fs.stat(installedExecutable);
  result.executable = {
    path: installedExecutable,
    name: path.basename(installedExecutable),
    bytes: executableStat.size,
    sha256: sha256Bytes(await fs.readFile(installedExecutable)),
  };
  assertEvidence(
    path.basename(installedExecutable) === expectedExecutableName,
    "Installed packaged executable identity",
    result.executable,
  );

  const testEnvironment = {
    ...NodeProcess.env,
    T3CODE_HOME: t3HomeRoot,
    T3CODE_COMMIT_HASH: productCommit,
    T3CODE_PORT: String(await allocatePort()),
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "",
    T3CODE_NO_BROWSER: "1",
    NODE_ENV: "production",
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    USERPROFILE: userProfileRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    ELECTRON_ENABLE_LOGGING: "1",
  };
  const requireFromProduct = createRequire(path.join(repoRoot, "apps/desktop/package.json"));
  const { _electron: electron } = requireFromProduct("playwright-core");

  let launched = await launchPackaged(electron, testEnvironment, "safe-recovery");
  await openAppearanceSettings(launched.page);
  const safe = await collectState(launched.page, "safe-recovery");
  assertEvidence(
    new URL(safe.url).searchParams.get("t3-appearance") === "safe",
    "Safe recovery URL active",
    { url: safe.url },
  );
  assertEvidence(safe.packageMarker === "", "Safe mode suppresses package CSS", safe);
  assertEvidence(safe.snippetMarker === "", "Safe mode suppresses snippet CSS", safe);
  assertEvidence(safe.packageFontFaces.length === 0, "Safe mode suppresses package font", safe);
  assertEvidence(
    await launched.page.getByRole("button", { name: "Restore recovery copy" }).isVisible(),
    "Recovery copy is available",
    null,
  );

  launched.page.once("dialog", (dialog) => void dialog.accept());
  await launched.page.getByRole("button", { name: "Restore recovery copy" }).click();
  await launched.page.waitForFunction(
    ({ packageMarkerProperty, snippetMarkerProperty }) => {
      const computed = getComputedStyle(document.documentElement);
      return (
        new URL(window.location.href).searchParams.get("t3-appearance") === null &&
        computed.getPropertyValue(packageMarkerProperty).trim() === "package-active" &&
        computed.getPropertyValue(snippetMarkerProperty).trim() === "snippet-active"
      );
    },
    { packageMarkerProperty, snippetMarkerProperty },
    { timeout: 60_000 },
  );
  await openAppearanceSettings(launched.page);
  const recoveryExit = await collectState(launched.page, "recovery-exit");
  assertEvidence(
    recoveryExit.packageMarker === "package-active",
    "Recovery restores package CSS",
    recoveryExit,
  );
  assertEvidence(
    recoveryExit.snippetMarker === "snippet-active",
    "Recovery restores snippet CSS",
    recoveryExit,
  );
  assertEvidence(
    recoveryExit.packageFontFaces.some((face) => face.status === "loaded"),
    "Recovery restores package font",
    recoveryExit,
  );
  assertEvidence(recoveryExit.packageVisible, "Recovery restores package inventory", recoveryExit);

  await launched.page.getByRole("button", { name: "Use light mode" }).click();
  await launched.page.waitForFunction(
    (property) =>
      !document.documentElement.classList.contains("dark") &&
      getComputedStyle(document.documentElement).getPropertyValue(property).trim() ===
        "package-active",
    packageMarkerProperty,
    { timeout: 30_000 },
  );
  const light = await collectState(launched.page, "appearance-light");
  assertEvidence(!light.dark, "Light mode applied", light);
  assertEvidence(
    light.packageMarker === "package-active",
    "Light mode preserves package CSS",
    light,
  );
  assertEvidence(
    light.snippetMarker === "snippet-active",
    "Light mode preserves snippet CSS",
    light,
  );
  assertEvidence(
    light.packageFontFaces.some((face) => face.status === "loaded"),
    "Light mode preserves package font",
    light,
  );

  await launched.page.getByRole("button", { name: "Use dark mode" }).click();
  await launched.page.waitForFunction(
    (property) =>
      document.documentElement.classList.contains("dark") &&
      getComputedStyle(document.documentElement).getPropertyValue(property).trim() ===
        "package-active",
    packageMarkerProperty,
    { timeout: 30_000 },
  );
  const dark = await collectState(launched.page, "appearance-dark");
  assertEvidence(dark.dark, "Dark mode applied", dark);
  assertEvidence(dark.packageMarker === "package-active", "Dark mode preserves package CSS", dark);
  assertEvidence(dark.snippetMarker === "snippet-active", "Dark mode preserves snippet CSS", dark);
  assertEvidence(
    dark.packageFontFaces.some((face) => face.status === "loaded"),
    "Dark mode preserves package font",
    dark,
  );

  const watchedCss = `:root { ${packageMarkerProperty}: watcher-active; }\n`;
  const watchedCssBytes = Buffer.from(watchedCss);
  const packageDirectory = path.join(stateRoot, "appearance", "packages", packageId);
  const manifestPath = path.join(packageDirectory, "manifest.json");
  const watchedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  watchedManifest.styles.desktop.sha256 = sha256Bytes(watchedCssBytes);
  watchedManifest.styles.desktop.sizeBytes = watchedCssBytes.byteLength;
  const watchStartedAt = Date.now();
  const cssTemporary = path.join(packageDirectory, `desktop.${randomUUID()}.css`);
  const manifestTemporary = path.join(packageDirectory, `manifest.${randomUUID()}.json`);
  await fs.writeFile(cssTemporary, watchedCssBytes);
  await fs.writeFile(manifestTemporary, `${JSON.stringify(watchedManifest, null, 2)}\n`, "utf8");
  await fs.rename(cssTemporary, path.join(packageDirectory, "desktop.css"));
  await fs.rename(manifestTemporary, manifestPath);
  await launched.page.waitForFunction(
    (property) =>
      getComputedStyle(document.documentElement).getPropertyValue(property).trim() ===
      "watcher-active",
    packageMarkerProperty,
    { timeout: 15_000 },
  );
  const watcher = await collectState(launched.page, "appearance-watcher");
  watcher.elapsedMs = Date.now() - watchStartedAt;
  assertEvidence(
    watcher.packageMarker === "watcher-active",
    "Windows watcher hot-reloads atomic package files",
    watcher,
  );
  assertEvidence(
    watcher.elapsedMs < 15_000,
    "Windows watcher completes within bounded wait",
    watcher,
  );

  await closePackaged(launched.electronApp);
  launched = await launchPackaged(electron, testEnvironment, "persisted-restart");
  await openAppearanceSettings(launched.page);
  const persistedRestart = await collectState(launched.page, "persisted-restart");
  assertEvidence(persistedRestart.dark, "Restart preserves dark mode", persistedRestart);
  assertEvidence(
    persistedRestart.packageMarker === "watcher-active",
    "Restart preserves watched package CSS",
    persistedRestart,
  );
  assertEvidence(
    persistedRestart.snippetMarker === "snippet-active",
    "Restart preserves snippet CSS",
    persistedRestart,
  );
  assertEvidence(
    persistedRestart.packageFontFaces.some((face) => face.status === "loaded"),
    "Restart preserves package font",
    persistedRestart,
  );

  launched.page.once("dialog", (dialog) => void dialog.accept());
  await launched.page.getByRole("button", { name: "Reset all appearance customizations" }).click();
  await launched.page.waitForFunction(
    ({ packageMarkerProperty, snippetMarkerProperty }) => {
      const computed = getComputedStyle(document.documentElement);
      return (
        computed.getPropertyValue(packageMarkerProperty).trim() === "" &&
        computed.getPropertyValue(snippetMarkerProperty).trim() === ""
      );
    },
    { packageMarkerProperty, snippetMarkerProperty },
    { timeout: 30_000 },
  );
  const reset = await collectState(launched.page, "reset-recovery");
  assertEvidence(reset.packageMarker === "", "Reset removes package CSS", reset);
  assertEvidence(reset.snippetMarker === "", "Reset removes snippet CSS", reset);
  assertEvidence(reset.packageFontFaces.length === 0, "Reset removes package font", reset);
  await closePackaged(launched.electronApp);

  const finalStorage = new DesktopAppearanceStorage(stateRoot, "0.0.37", "win32");
  const finalState = await finalStorage.load();
  const finalQuarantine = await finalStorage.readQuarantinedState();
  finalStorage.close();
  result.persisted = {
    seeded: summarizeState(activeState),
    final: summarizeState(finalState),
    quarantine: finalQuarantine === null ? null : summarizeState(finalQuarantine),
  };
  assertEvidence(
    Object.keys(finalState.packages).length === 0,
    "Reset persists empty package inventory",
    result.persisted.final,
  );
  assertEvidence(
    finalState.snippets.length === 0,
    "Reset persists empty snippet inventory",
    result.persisted.final,
  );
  assertEvidence(
    finalQuarantine?.packages[packageId] !== undefined,
    "Reset persists recovery package",
    result.persisted.quarantine,
  );
  assertEvidence(
    finalQuarantine?.snippets.some((snippet) => snippet.id === "windows-evidence-snippet"),
    "Reset persists recovery snippet",
    result.persisted.quarantine,
  );

  result.status = "passed";
  result.completedAt = new Date().toISOString();
  await writeJson(path.join(evidenceRoot, "summary.json"), result);
}

try {
  await main();
} catch (error) {
  result.status = "failed";
  result.completedAt = new Date().toISOString();
  result.failure =
    error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  await fs.mkdir(evidenceRoot, { recursive: true });
  await writeJson(path.join(evidenceRoot, "summary.json"), result);
  throw error;
} finally {
  if (activeElectronApp !== null) {
    const pid = activeElectronApp.process()?.pid;
    try {
      await activeElectronApp.close();
    } catch {
      if (pid !== undefined) {
        spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      }
    }
  }
  if (installedExecutable !== null) {
    const uninstallerCandidates = await walkExecutables(path.dirname(installedExecutable));
    const uninstaller = uninstallerCandidates.find((candidate) =>
      path.basename(candidate).toLowerCase().startsWith("uninstall"),
    );
    if (uninstaller !== undefined) {
      spawnSync(uninstaller, ["/S"], { stdio: "ignore", timeout: 120_000, windowsHide: true });
    }
  }
}
