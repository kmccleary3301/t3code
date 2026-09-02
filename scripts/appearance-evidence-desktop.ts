/// <reference lib="dom" />
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Evidence drivers own disposable host processes and filesystem state.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";
import {
  chromium,
  _electron as electron,
  type Browser,
  type ElectronApplication,
  type Page,
} from "playwright-core";
import * as Schema from "effect/Schema";

import {
  createActualSurfaceChildEnv,
  commandOutput,
  createActualSurfaceEnvironment,
  stopActualSurfaceProcess,
  reserveAvailablePort,
  redactActualSurfaceLog,
} from "./actual-surface-environment.ts";
import {
  APPEARANCE_INSTRUMENTATION_INIT_SCRIPT,
  InstrumentationSnapshotSchema,
  STYLESHEET_PROBE_SCRIPT,
  decodeStylesheetProbe,
  metricDelta,
  stylesheetMetricsFromProbe,
  type AppearanceMode,
  type InstrumentationSnapshot,
  type SurfaceReadiness,
  type StylesheetMetrics,
  type StylesheetProbe,
  type StylesheetRecord,
} from "./appearance-evidence-playwright.ts";
import type { MetricSample } from "./appearance-evidence.ts";
import type { DriverArtifact, AppearanceDriverResult } from "./appearance-evidence-web.ts";

export interface DesktopDriverOptions {
  readonly measure: boolean;
  readonly coldCount: number;
  readonly pairCount: number;
}
const GRACEFUL_ELECTRON_SHUTDOWN_TIMEOUT_MS = 15_000;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
interface ElectronLaunchCommand {
  readonly electronPath: string;
  readonly args: ReadonlyArray<string>;
}

async function captureMarkedProcessIds(processTitle: string): Promise<ReadonlyArray<number>> {
  if (NodeProcess.platform === "win32") return [];
  const output = await commandOutput("ps", ["-ww", "-axo", "pid=,command="]).catch(() => "");
  const processIds: number[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match?.[2]?.trim() === processTitle) processIds.push(Number(match[1]));
  }
  return processIds;
}

async function stopMarkedProcesses(processTitle: string): Promise<void> {
  const processIds = await captureMarkedProcessIds(processTitle);
  for (const pid of processIds) {
    try {
      NodeProcess.kill(pid, "SIGTERM");
    } catch {
      // A gracefully stopped evidence process is already gone.
    }
  }
  if (processIds.length === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  for (const pid of await captureMarkedProcessIds(processTitle)) {
    try {
      NodeProcess.kill(pid, "SIGKILL");
    } catch {
      // The exact marked process exited after the second identity check.
    }
  }
}

async function stopWindowsProcessTree(child: NodeChildProcess.ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    await commandOutput("taskkill", ["/pid", String(pid), "/t", "/f"]);
  } catch (cause) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw cause;
  }
}

async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  const child = application.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await Promise.race([
      application.evaluate(({ app }) => app.quit()).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_ELECTRON_SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      if (NodeProcess.platform === "win32") await stopWindowsProcessTree(child);
      else await stopActualSurfaceProcess(child);
    }
  }
  await Promise.race([
    application.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
interface DesktopRouterBlockerObservation {
  readonly stage:
    | "authenticated-router"
    | "launch-or-cdp-readiness"
    | "renderer-inspection"
    | "evidence-collection"
    | "cleanup";
  readonly rendererReady: boolean;
  readonly bridgeReady: boolean;
  readonly bearerResolved: boolean;
  readonly backendSessionStatus: number | null;
  readonly settingsVisible: boolean;
  readonly pathname: string;
}

class DesktopAppearanceBlockedError extends Error {
  override readonly name = "DesktopAppearanceBlockedError";
  readonly code: string;
  readonly classification: "BLOCKED_PRODUCT" | "BLOCKED_INFRASTRUCTURE";
  readonly observation: DesktopRouterBlockerObservation;
  readonly runtimeVersion: string;
  constructor(
    code: string,
    classification: "BLOCKED_PRODUCT" | "BLOCKED_INFRASTRUCTURE",
    observation: DesktopRouterBlockerObservation,
    runtimeVersion: string,
    options?: ErrorOptions,
  ) {
    super(`Desktop appearance evidence is blocked: ${code}.`, options);
    this.code = code;
    this.classification = classification;
    this.observation = observation;
    this.runtimeVersion = runtimeVersion;
  }
}
function unobservedDesktopBlocker(
  stage: DesktopRouterBlockerObservation["stage"],
): DesktopRouterBlockerObservation {
  return {
    stage,
    rendererReady: false,
    bridgeReady: false,
    bearerResolved: false,
    backendSessionStatus: null,
    settingsVisible: false,
    pathname: "",
  };
}

async function desktopRendererEvaluate<T>(
  application: ElectronApplication,
  source: string,
  timeoutMs = 5_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Electron renderer evaluation timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    void application
      .evaluate(async ({ webContents }, expression) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => candidate.getURL().startsWith("t3code"));
        if (!contents) throw new Error("Electron application renderer is unavailable.");
        return await contents.executeJavaScript(expression);
      }, source)
      .then(
        (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
  });
}

async function waitForDesktopRenderer(
  application: ElectronApplication,
  predicate: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ready = await desktopRendererEvaluate<boolean>(
      application,
      `Boolean(${predicate})`,
    ).catch(() => false);
    if (ready) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the Electron renderer state.");
}
async function inspectDesktopRouterBlocker(
  application: ElectronApplication,
): Promise<DesktopRouterBlockerObservation> {
  return await desktopRendererEvaluate<DesktopRouterBlockerObservation>(
    application,
    `(async () => {
      const bridge = window.desktopBridge;
      const bootstraps = bridge?.getLocalEnvironmentBootstraps?.() ?? [];
      const primary = bootstraps.find((entry) => entry.id === "primary") ?? bootstraps[0];
      let bearer = null;
      try {
        bearer = await Promise.race([
          bridge?.getLocalEnvironmentBearerToken?.(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("bearer-timeout")), 5_000)),
        ]);
      } catch {}
      let backendSessionStatus = null;
      if (typeof bearer === "string" && primary?.httpBaseUrl) {
        try {
          const response = await fetch(new URL("/api/auth/session", primary.httpBaseUrl), {
            headers: { Authorization: "Bearer " + bearer },
            signal: AbortSignal.timeout(5_000),
          });
          backendSessionStatus = response.status;
        } catch {}
      }
      return {
        stage: "authenticated-router",
        rendererReady: document.readyState === "complete",
        bridgeReady: typeof bridge?.getLocalEnvironmentBearerToken === "function",
        bearerResolved: typeof bearer === "string" && bearer.length > 0,
        backendSessionStatus,
        settingsVisible: document.querySelectorAll('[aria-label="Settings"]').length > 0,
        pathname: window.location.pathname,
      };
    })()`,
  );
}

async function readDesktopInstrumentation(
  application: ElectronApplication,
): Promise<InstrumentationSnapshot> {
  const raw = await desktopRendererEvaluate<unknown>(
    application,
    `(() => {
      const state = window.__T3_APPEARANCE_EVIDENCE__;
      if (!state) throw new Error("Appearance evidence instrumentation was not installed.");
      return state.snapshot();
    })()`,
  );
  return Schema.decodeUnknownSync(InstrumentationSnapshotSchema)(raw);
}

async function readDesktopAppearanceReadiness(
  application: ElectronApplication,
): Promise<SurfaceReadiness> {
  await waitForDesktopRenderer(
    application,
    `(window.location.pathname === "/settings/appearance" ||
      window.location.hash.includes("/settings/appearance")) &&
      document.querySelectorAll("[data-theme-library-card]").length > 0`,
  );
  const readiness = await desktopRendererEvaluate<{
    readonly url: string;
    readonly themeLibraryCards: number;
    readonly fontsReady: boolean;
    readonly resolvedAppearance: AppearanceMode;
  }>(
    application,
    `(async () => {
      await document.fonts.ready;
      for (let index = 0; index < 2; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return {
        url: window.location.href,
        themeLibraryCards: document.querySelectorAll("[data-theme-library-card]").length,
        fontsReady: document.fonts.status === "loaded",
        resolvedAppearance: document.documentElement.classList.contains("dark") ? "dark" : "light",
      };
    })()`,
  );
  const url = new URL(readiness.url);
  if (url.pathname !== "/settings/appearance" && !url.hash.includes("/settings/appearance")) {
    throw new Error("Real desktop /settings/appearance route was not ready.");
  }
  if (readiness.themeLibraryCards < 1 || !readiness.fontsReady) {
    throw new Error("Desktop appearance readiness requires theme cards and loaded fonts.");
  }
  return { ...readiness, animationFrames: 2 };
}

async function switchDesktopAppearance(
  application: ElectronApplication,
  appearance: AppearanceMode,
): Promise<{
  readonly elapsedMs: number;
  readonly before: InstrumentationSnapshot;
  readonly after: InstrumentationSnapshot;
}> {
  const before = await readDesktopInstrumentation(application);
  const elapsedMs = await desktopRendererEvaluate<number>(
    application,
    `(async () => {
      const appearance = ${JSON.stringify(appearance)};
      const control = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === "Use " + appearance + " mode",
      );
      if (!control) throw new Error("Desktop appearance mode control was not present.");
      const started = performance.now();
      control.click();
      while (document.documentElement.classList.contains("dark") !== (appearance === "dark")) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      for (let index = 0; index < 2; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return Math.max(0, performance.now() - started);
    })()`,
  );
  return {
    elapsedMs,
    before,
    after: await readDesktopInstrumentation(application),
  };
}

async function installDesktopRendererInstrumentation(
  application: ElectronApplication,
): Promise<void> {
  await desktopRendererEvaluate(
    application,
    `${APPEARANCE_INSTRUMENTATION_INIT_SCRIPT}
    (() => {
      if (window.__T3_APPEARANCE_CONSOLE__) return;
      const limit = 512;
      const entries = [];
      let start = 0;
      let dropped = 0;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const clamp = (value) => {
        const bytes = encoder.encode(value);
        if (bytes.byteLength <= 4096) return value;
        return decoder.decode(bytes.slice(0, 4096)) + "[truncated]";
      };
      const push = (value) => {
        const entry = clamp(value);
        if (entries.length < limit) {
          entries.push(entry);
          return;
        }
        entries[start] = entry;
        start = (start + 1) % limit;
        dropped += 1;
      };
      const capture = Object.freeze({
        snapshot: () => ({
          dropped,
          entries:
            start === 0
              ? [...entries]
              : [...entries.slice(start), ...entries.slice(0, start)],
        }),
      });
      Object.defineProperty(window, "__T3_APPEARANCE_CONSOLE__", {
        configurable: false,
        enumerable: false,
        value: capture,
        writable: false,
      });
      for (const level of ["debug", "info", "log", "warn", "error"]) {
        const original = console[level];
        console[level] = (...args) => {
          push(level + ": " + args.map((value) => String(value)).join(" "));
          return original.apply(console, args);
        };
      }
      window.addEventListener("error", (event) => push("pageerror: " + event.message));
      window.addEventListener("unhandledrejection", (event) =>
        push("unhandledrejection: " + String(event.reason)),
      );
    })()`,
  );
}

function safeDesktopStylesheetHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href);
    return redactActualSurfaceLog(`${parsed.origin}${parsed.pathname}`).trim();
  } catch {
    return redactActualSurfaceLog(href.replace(/[?#][^\s]*/gu, "")).trim();
  }
}

interface DesktopSurfaceEvidence {
  readonly stylesheetInventory: ReadonlyArray<StylesheetRecord>;
  readonly stylesheetMetrics: StylesheetMetrics;
  readonly dom: string;
  readonly styles: string;
  readonly ariaSnapshot: string;
  readonly console: ReadonlyArray<string>;
  readonly screenshot: Uint8Array;
}

async function collectDesktopSurfaceEvidence(
  application: ElectronApplication,
  stylesheetProbe?: StylesheetProbe,
): Promise<DesktopSurfaceEvidence> {
  const probe =
    stylesheetProbe ??
    decodeStylesheetProbe(
      await desktopRendererEvaluate<unknown>(application, STYLESHEET_PROBE_SCRIPT),
    );
  const stylesheetMetrics = stylesheetMetricsFromProbe(probe);
  const pageData = await desktopRendererEvaluate<{
    readonly dom: string;
    readonly styles: string;
    readonly console: ReadonlyArray<string>;
  }>(
    application,
    `(() => {
      const styleProperties = [
        "background-color",
        "color",
        "font-family",
        "font-size",
        "line-height",
        "border-color",
        "box-shadow",
        "transition-duration",
      ];
      const styles = ["html", "body", "[data-theme-library-card]"]
        .map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return selector + ":missing";
          const computed = getComputedStyle(element);
          return selector + ":{" + styleProperties
            .map((property) => property + ":" + computed.getPropertyValue(property).trim())
            .join(";") + "}";
        })
        .join("\\n");
      const clone = document.documentElement.cloneNode(true);
      if (!(clone instanceof HTMLElement)) throw new Error("Could not clone document for evidence.");
      for (const element of clone.querySelectorAll("script,noscript,iframe,canvas")) element.remove();
      const sensitiveName = /token|secret|password|credential|authorization|api[-_]?key/iu;
      for (const element of clone.querySelectorAll("*")) {
        const identifiesSensitiveField = ["name", "id", "aria-label", "data-testid"].some((name) =>
          sensitiveName.test(element.getAttribute(name) ?? "")
        );
        if (identifiesSensitiveField) element.textContent = "[REDACTED]";
        for (const attribute of [...element.attributes]) {
          if (sensitiveName.test(attribute.name) || sensitiveName.test(attribute.value)) {
            element.removeAttribute(attribute.name);
          } else if (attribute.name === "value") {
            element.setAttribute(attribute.name, "");
          } else if (attribute.name === "href" || attribute.name === "src") {
            try {
              const parsed = new URL(attribute.value, document.baseURI);
              element.setAttribute(attribute.name, parsed.origin + parsed.pathname);
            } catch {
              element.removeAttribute(attribute.name);
            }
          }
        }
      }
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        node.textContent = (node.textContent ?? "")
          .replace(/\\bBearer\\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
          .replace(
            /((?:token|secret|password|credential|authorization|api[-_]?key)\\s*[=:]\\s*)[^\\s,;}]+/giu,
            "$1[REDACTED]"
          );
      }
      const consoleCapture = window.__T3_APPEARANCE_CONSOLE__?.snapshot?.() ?? {
        dropped: 0,
        entries: [],
      };
      return {
        dom: clone.outerHTML,
        styles,
        console:
          consoleCapture.dropped === 0
            ? consoleCapture.entries
            : [
                "evidence: " + consoleCapture.dropped + " earlier console entries dropped",
                ...consoleCapture.entries,
              ],
      };
    })()`,
  );
  const nativeEvidence = await application.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((candidate) => candidate.getURL().startsWith("t3code"));
    if (!contents) throw new Error("Electron application renderer is unavailable.");
    const screenshot = (await contents.capturePage()).toPNG().toString("base64");
    const attached = contents.debugger.isAttached();
    if (!attached) contents.debugger.attach("1.3");
    try {
      const accessibility = await contents.debugger.sendCommand("Accessibility.getFullAXTree");
      return { accessibility, screenshot };
    } finally {
      if (!attached && contents.debugger.isAttached()) contents.debugger.detach();
    }
  });
  return {
    stylesheetInventory: probe.records.map((sheet) => ({
      ...sheet,
      href: safeDesktopStylesheetHref(sheet.href),
    })),
    stylesheetMetrics,
    dom: redactActualSurfaceLog(pageData.dom),
    styles: redactActualSurfaceLog(pageData.styles),
    ariaSnapshot: redactActualSurfaceLog(JSON.stringify(nativeEvidence.accessibility, null, 2)),
    console: pageData.console.map((message) => redactActualSurfaceLog(message)),
    screenshot: Buffer.from(nativeEvidence.screenshot, "base64"),
  };
}

async function resolveEvidenceElectronLaunchCommand(
  args: ReadonlyArray<string>,
): Promise<ElectronLaunchCommand> {
  const moduleUrl = new URL("../apps/desktop/scripts/electron-launcher.mjs", import.meta.url).href;
  const launcher = (await import(moduleUrl)) as {
    readonly resolveElectronBinaryPath: () => string;
    readonly resolveElectronLaunchCommand: (args: ReadonlyArray<string>) => ElectronLaunchCommand;
  };
  if (NodeProcess.platform === "darwin") {
    return { electronPath: launcher.resolveElectronBinaryPath(), args };
  }
  return launcher.resolveElectronLaunchCommand(args);
}
function electronRuntimeVersion(executablePath: string): string {
  const match = executablePath.match(/[\\/]electron@([^\\/]+)[\\/]/u);
  return `Electron ${match?.[1] ?? "unknown"}`;
}
async function closeCdpBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function connectToElectronRenderer(
  port: number,
  child: NodeChildProcess.ChildProcess,
): Promise<{ readonly browser: Browser; readonly page: Page }> {
  const deadline = performance.now() + 15_000;
  let browser: Browser | undefined;
  while (performance.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_000 });
      break;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!browser) throw new Error("Timed out connecting to the Electron renderer debugging port.");

  while (performance.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("t3code"));
    if (page) return { browser, page };
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  await closeCdpBrowser(browser);
  throw new Error("Timed out waiting for the Electron renderer page.");
}

async function inspectDesktopRouterPage(page: Page): Promise<DesktopRouterBlockerObservation> {
  return (await page.evaluate(`(async () => {
    const bridge = window.desktopBridge;
    const bootstraps = bridge?.getLocalEnvironmentBootstraps?.() ?? [];
    const primary = bootstraps.find((entry) => entry.id === "primary") ?? bootstraps[0];
    let bearer = null;
    try {
      bearer = await Promise.race([
        bridge?.getLocalEnvironmentBearerToken?.(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("bearer-timeout")), 3_000)),
      ]);
    } catch {}
    let backendSessionStatus = null;
    if (typeof bearer === "string" && primary?.httpBaseUrl) {
      try {
        const response = await fetch(new URL("/api/auth/session", primary.httpBaseUrl), {
          headers: { Authorization: "Bearer " + bearer },
          signal: AbortSignal.timeout(3_000),
        });
        backendSessionStatus = response.status;
      } catch {}
    }
    return {
      stage: "authenticated-router",
      rendererReady: document.readyState === "complete",
      bridgeReady: typeof bridge?.getLocalEnvironmentBearerToken === "function",
      bearerResolved: typeof bearer === "string" && bearer.length > 0,
      backendSessionStatus,
      settingsVisible: document.querySelectorAll('[aria-label="Settings"]').length > 0,
      pathname: window.location.pathname,
    };
  })()`)) as DesktopRouterBlockerObservation;
}

async function preflightDesktopRouter(
  launchCommand: ElectronLaunchCommand,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<DesktopAppearanceBlockedError | null> {
  const runtimeVersion = electronRuntimeVersion(launchCommand.electronPath);
  const infrastructureBlocker = (
    stage: DesktopRouterBlockerObservation["stage"],
    code: string,
    cause?: unknown,
  ) =>
    new DesktopAppearanceBlockedError(
      code,
      "BLOCKED_INFRASTRUCTURE",
      {
        stage,
        rendererReady: false,
        bridgeReady: false,
        bearerResolved: false,
        backendSessionStatus: null,
        settingsVisible: false,
        pathname: "",
      },
      runtimeVersion,
      cause === undefined ? undefined : { cause },
    );
  const port = await reserveAvailablePort();
  const child = NodeChildProcess.spawn(
    launchCommand.electronPath,
    [`--remote-debugging-port=${port}`, ...launchCommand.args],
    {
      cwd,
      env,
      stdio: "ignore",
      detached: NodeProcess.platform !== "win32",
    },
  );
  let browser: Browser | undefined;
  let blocker: DesktopAppearanceBlockedError | null = null;
  try {
    const connected = await connectToElectronRenderer(port, child);
    browser = connected.browser;
    const deadline = performance.now() + 12_000;
    let settingsVisible = false;
    while (performance.now() < deadline) {
      settingsVisible = await Promise.race([
        connected.page
          .evaluate<boolean>(`document.querySelectorAll('[aria-label="Settings"]').length > 0`)
          .catch(() => false),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (settingsVisible) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!settingsVisible) {
      try {
        const observation = await Promise.race([
          inspectDesktopRouterPage(connected.page),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Timed out inspecting the Electron router blocker.")),
              8_000,
            ),
          ),
        ]);
        blocker =
          observation.rendererReady &&
          observation.bridgeReady &&
          observation.bearerResolved &&
          observation.backendSessionStatus === 200
            ? new DesktopAppearanceBlockedError(
                "desktop-authenticated-router-pending",
                "BLOCKED_PRODUCT",
                observation,
                runtimeVersion,
              )
            : infrastructureBlocker(
                "renderer-inspection",
                "desktop-renderer-readiness-unclassified",
              );
      } catch (cause) {
        blocker = infrastructureBlocker(
          "renderer-inspection",
          "desktop-renderer-inspection-timeout",
          cause,
        );
      }
    }
  } catch (cause) {
    blocker = infrastructureBlocker(
      "launch-or-cdp-readiness",
      "desktop-launch-or-cdp-readiness-timeout",
      cause,
    );
  }
  const cleanupFailures: unknown[] = [];
  try {
    await stopActualSurfaceProcess(child, { processGroup: true });
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  try {
    await closeCdpBrowser(browser);
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  if (cleanupFailures.length > 0) {
    blocker = infrastructureBlocker(
      "cleanup",
      "desktop-process-cleanup-failed",
      new AggregateError(cleanupFailures),
    );
  }
  return blocker;
}

async function launchDesktop(appearance: AppearanceMode): Promise<{
  readonly app: ElectronApplication;
  readonly runtimeVersion: string;
  readonly coldStartupMs: number;
  readonly dispose: () => Promise<void>;
}> {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "appearance-desktop-"));
  const backendProcessTitle = `t3code-evidence-${NodeCrypto.randomUUID()}`;
  let environment: Awaited<ReturnType<typeof createActualSurfaceEnvironment>> | undefined;
  let app: ElectronApplication | undefined;
  let runtimeVersion = "Electron unknown";
  const dispose = async (): Promise<void> => {
    const failures: unknown[] = [];
    if (app) {
      try {
        await closeElectronApplication(app);
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      await stopMarkedProcesses(backendProcessTitle);
    } catch (cause) {
      failures.push(cause);
    }
    if (environment) {
      try {
        await environment.dispose();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Desktop appearance client resources could not be fully stopped.",
      );
    }
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  };
  try {
    environment = await createActualSurfaceEnvironment({
      baseDir: NodePath.join(baseDir, "environment"),
      workspaceRoot: NodePath.join(baseDir, "environment", "workspace"),
      label: "appearance-desktop-seed",
      temporaryRoot: true,
    });
    await stopActualSurfaceProcess(environment.server);
    const home = NodePath.join(baseDir, "home");
    const temporaryDirectory = NodePath.join(baseDir, "tmp");
    await Promise.all([
      NodeFSP.mkdir(home, { recursive: true, mode: 0o700 }),
      NodeFSP.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const childEnv = {
      ...createActualSurfaceChildEnv(NodeProcess.env, {
        HOME: home,
        TMPDIR: temporaryDirectory,
        NODE_ENV: "production",
        NO_COLOR: "1",
      }),
      NODE_OPTIONS: `--title=${backendProcessTitle}`,
      T3CODE_HOME: environment.baseDir,
      T3CODE_NO_BROWSER: "1",
    };
    const desktopRoot = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "..",
      "apps",
      "desktop",
    );

    const launchCommand = await resolveEvidenceElectronLaunchCommand([
      `--user-data-dir=${NodePath.join(baseDir, "electron-user-data")}`,
      `--t3code-dev-root=${desktopRoot}`,
      NodePath.join("dist-electron", "main.cjs"),
    ]);
    runtimeVersion = electronRuntimeVersion(launchCommand.electronPath);
    const preflightBlocker = await preflightDesktopRouter(launchCommand, desktopRoot, childEnv);
    if (preflightBlocker) throw preflightBlocker;
    const clientStarted = performance.now();
    app = await electron.launch({
      executablePath: launchCommand.electronPath,
      args: [...launchCommand.args],
      cwd: desktopRoot,
      env: childEnv,
      timeout: 15_000,
    });
    runtimeVersion = `Electron ${await app.evaluate(() => process.versions.electron ?? "unknown")}`;
    try {
      await waitForDesktopRenderer(
        app,
        `document.querySelectorAll('[aria-label="Settings"]').length > 0`,
        20_000,
      );
    } catch (cause) {
      const observation = await Promise.race([
        inspectDesktopRouterBlocker(app),
        new Promise<DesktopRouterBlockerObservation>((resolve) =>
          setTimeout(
            () =>
              resolve({
                stage: "renderer-inspection",
                rendererReady: false,
                bridgeReady: false,
                bearerResolved: false,
                backendSessionStatus: null,
                settingsVisible: false,
                pathname: "",
              }),
            8_000,
          ),
        ),
      ]);
      const authenticated =
        observation.rendererReady &&
        observation.bridgeReady &&
        observation.bearerResolved &&
        observation.backendSessionStatus === 200;
      throw new DesktopAppearanceBlockedError(
        authenticated
          ? "desktop-authenticated-router-pending"
          : "desktop-renderer-inspection-timeout",
        authenticated ? "BLOCKED_PRODUCT" : "BLOCKED_INFRASTRUCTURE",
        observation,
        runtimeVersion,
        { cause },
      );
    }
    await installDesktopRendererInstrumentation(app);
    await desktopRendererEvaluate<void>(
      app,
      `(() => {
        const control = document.querySelector('[aria-label="Settings"]');
        if (!control) throw new Error("Desktop Settings control was not present.");
        control.click();
      })()`,
    );
    await waitForDesktopRenderer(app, `window.location.pathname.startsWith("/settings")`);
    await desktopRendererEvaluate<void>(
      app,
      `(() => {
        const control = [...document.querySelectorAll("a")].find(
          (candidate) => candidate.textContent?.trim() === "Appearance",
        );
        if (!control) throw new Error("Desktop Appearance link was not present.");
        control.click();
      })()`,
    );
    const readiness = await readDesktopAppearanceReadiness(app);
    if (readiness.resolvedAppearance !== appearance) {
      await switchDesktopAppearance(app, appearance);
    }
    return {
      app,
      runtimeVersion,
      coldStartupMs: performance.now() - clientStarted,
      dispose,
    };
  } catch (error) {
    let blocked =
      error instanceof DesktopAppearanceBlockedError
        ? error
        : new DesktopAppearanceBlockedError(
            "desktop-launch-readiness-failed",
            "BLOCKED_INFRASTRUCTURE",
            {
              stage: "launch-or-cdp-readiness",
              rendererReady: false,
              bridgeReady: false,
              bearerResolved: false,
              backendSessionStatus: null,
              settingsVisible: false,
              pathname: "",
            },
            runtimeVersion,
            { cause: error },
          );
    try {
      await dispose();
    } catch (cause) {
      blocked = new DesktopAppearanceBlockedError(
        "desktop-process-cleanup-failed",
        "BLOCKED_INFRASTRUCTURE",
        {
          stage: "cleanup",
          rendererReady: false,
          bridgeReady: false,
          bearerResolved: false,
          backendSessionStatus: null,
          settingsVisible: false,
          pathname: "",
        },
        runtimeVersion,
        { cause },
      );
    }
    throw blocked;
  }
}

async function nativeTheme(
  app: ElectronApplication,
): Promise<{ readonly themeSource: string; readonly shouldUseDarkColors: boolean }> {
  return await app.evaluate(({ nativeTheme }) => ({
    themeSource: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
  }));
}

async function appRendererMemory(app: ElectronApplication): Promise<number | null> {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      type: metric.type,
      workingSetSizeKilobytes: metric.memory.workingSetSize,
    })),
  );
  const rendererMetrics = metrics.filter((metric) => metric.type === "Tab");
  if (rendererMetrics.length === 0) return null;
  return (
    rendererMetrics.reduce((total, metric) => total + metric.workingSetSizeKilobytes, 0) * 1024
  );
}

export async function runDesktopAppearanceDriver(
  options: DesktopDriverOptions,
): Promise<AppearanceDriverResult & { readonly client: "desktop" }> {
  const samples: MetricSample[] = [];
  const artifacts: DriverArtifact[] = [];
  const capabilities = new Set<string>();
  let sampleIndex = 0;
  let runtimeVersion: string | undefined;
  const runSession = async (
    appearance: AppearanceMode,
    collectVisual: boolean,
    collectWarmSwitches: boolean,
  ): Promise<void> => {
    const session = await launchDesktop(appearance);
    let sessionFailure: { readonly cause: unknown } | undefined;
    try {
      if (runtimeVersion && runtimeVersion !== session.runtimeVersion) {
        throw new Error("Electron runtime changed during one evidence run.");
      }
      runtimeVersion = session.runtimeVersion;
      const readiness = await readDesktopAppearanceReadiness(session.app);
      if (readiness.resolvedAppearance !== appearance) {
        throw new Error(
          `Expected cold ${appearance} appearance, got ${readiness.resolvedAppearance}.`,
        );
      }
      samples.push({
        kind: "cold-startup",
        client: "desktop",
        appearance,
        value: session.coldStartupMs,
        unit: "ms",
        sampleIndex: sampleIndex++,
      });
      const initialTheme = await nativeTheme(session.app);
      if (initialTheme.themeSource !== appearance) {
        capabilities.add(`nativeTheme: expected ${appearance}, got ${initialTheme.themeSource}`);
      }
      const instrumentation = await readDesktopInstrumentation(session.app);
      if (instrumentation.capabilities.reactDevtools.status === "unavailable") {
        capabilities.add(
          `react-devtools: ${instrumentation.capabilities.reactDevtools.reason ?? "unavailable"}`,
        );
      }
      if (instrumentation.capabilities.longTasks.status === "unavailable") {
        capabilities.add(
          `long-task: ${instrumentation.capabilities.longTasks.reason ?? "unavailable"}`,
        );
      }
      const memory = await appRendererMemory(session.app);
      if (memory === null) {
        capabilities.add("memory: Electron app.getAppMetrics has no renderer metric");
      } else {
        samples.push({
          kind: "memory",
          client: "desktop",
          appearance,
          value: memory,
          unit: "bytes",
          sampleIndex: sampleIndex++,
        });
      }
      const stylesheetProbe = decodeStylesheetProbe(
        await desktopRendererEvaluate<unknown>(session.app, STYLESHEET_PROBE_SCRIPT),
      );
      const stylesheetMetrics = stylesheetMetricsFromProbe(stylesheetProbe);
      samples.push({
        kind: "stylesheet-count",
        client: "desktop",
        appearance,
        value: stylesheetMetrics.total,
        unit: "count",
        sampleIndex: sampleIndex++,
      });
      if (collectVisual) {
        const evidence = await collectDesktopSurfaceEvidence(session.app, stylesheetProbe);
        const visualRoot = `visual/settings-theme-library/${appearance}`;
        artifacts.push(
          { path: `${visualRoot}/screenshot.png`, content: evidence.screenshot },
          { path: `${visualRoot}/aria.yaml`, content: evidence.ariaSnapshot },
          { path: `${visualRoot}/dom.html`, content: evidence.dom },
          { path: `${visualRoot}/styles.txt`, content: evidence.styles },
          {
            path: `${visualRoot}/stylesheets.json`,
            content: json(evidence.stylesheetInventory),
          },
          { path: `${visualRoot}/console.json`, content: json(evidence.console) },
          {
            path: `${visualRoot}/stylesheet-metrics.json`,
            content: json(evidence.stylesheetMetrics),
          },
          {
            path: `${visualRoot}/native-theme.json`,
            content: json(await nativeTheme(session.app)),
          },
        );
      }
      if (collectWarmSwitches) {
        await switchDesktopAppearance(session.app, "light");
        for (let index = 0; index < options.pairCount * 2; index += 1) {
          const nextAppearance: AppearanceMode = index % 2 === 0 ? "dark" : "light";
          const switched = await switchDesktopAppearance(session.app, nextAppearance);
          const expectedTheme = await nativeTheme(session.app);
          if (expectedTheme.themeSource !== nextAppearance) {
            capabilities.add(
              `nativeTheme: expected ${nextAppearance}, got ${expectedTheme.themeSource}`,
            );
          }
          const delta = metricDelta(switched.before, switched.after);
          samples.push(
            {
              kind: "warm-switch",
              client: "desktop",
              appearance: nextAppearance,
              value: switched.elapsedMs,
              unit: "ms",
              sampleIndex: index,
            },
            {
              kind: "react-commits",
              client: "desktop",
              appearance: nextAppearance,
              value: delta.reactCommits,
              unit: "count",
              sampleIndex: index + 10_000,
            },
            {
              kind: "long-task",
              client: "desktop",
              appearance: nextAppearance,
              value: delta.maxLongTaskDurationMs,
              unit: "ms",
              sampleIndex: index + 10_000,
            },
            {
              kind: "compiler",
              client: "desktop",
              appearance: nextAppearance,
              value: delta.compileDurationMs,
              unit: "ms",
              sampleIndex: index + 10_000,
            },
            {
              kind: "stylesheet-replacement",
              client: "desktop",
              appearance: nextAppearance,
              value: delta.stylesheetReplacementDurationMs,
              unit: "ms",
              sampleIndex: index + 10_000,
            },
          );
        }
      }
    } catch (cause) {
      sessionFailure = { cause };
    }
    try {
      await session.dispose();
    } catch (cleanupCause) {
      throw new DesktopAppearanceBlockedError(
        "desktop-process-cleanup-failed",
        "BLOCKED_INFRASTRUCTURE",
        unobservedDesktopBlocker("cleanup"),
        runtimeVersion ?? session.runtimeVersion,
        {
          cause:
            sessionFailure === undefined
              ? cleanupCause
              : new AggregateError(
                  [sessionFailure.cause, cleanupCause],
                  "desktop session and cleanup both failed",
                ),
        },
      );
    }
    if (sessionFailure !== undefined) {
      throw sessionFailure.cause;
    }
  };
  try {
    if (options.measure) {
      for (const appearance of ["light", "dark"] as const) {
        for (let index = 0; index < options.coldCount; index += 1) {
          await runSession(appearance, index === 0, appearance === "light" && index === 0);
        }
      }
    } else {
      await runSession("light", true, false);
      await runSession("dark", true, false);
    }
  } catch (cause) {
    const error =
      cause instanceof DesktopAppearanceBlockedError
        ? cause
        : new DesktopAppearanceBlockedError(
            "desktop-evidence-collection-failed",
            "BLOCKED_PRODUCT",
            unobservedDesktopBlocker("evidence-collection"),
            runtimeVersion ?? "Electron not observed",
            { cause },
          );
    const blocker = error.code;
    return {
      status: "blocked",
      client: "desktop",
      cards: [],
      samples: [],
      artifacts: [
        {
          path: `blockers/${blocker}.json`,
          content: json({
            code: blocker,
            classification: error.classification,
            promotable: false,
            observation: error.observation,
          }),
        },
      ],
      capabilities: [],
      blockers: [blocker],
      observedWorkload: {
        coldLaunchesPerAppearance: 0,
        alternatingPairs: 0,
        switches: 0,
      },
      runtimeVersion: error.runtimeVersion,
    };
  }
  if (!runtimeVersion) throw new Error("Electron runtime identity was not observed.");
  const platformCard =
    NodeProcess.platform === "darwin"
      ? "desktop-macos"
      : NodeProcess.platform === "win32"
        ? "desktop-windows"
        : "desktop-linux";
  return {
    status: "complete",
    client: "desktop",
    cards: [
      "appearance-dark",
      "appearance-light",
      platformCard,
      "settings-theme-library",
      "theme-built-in",
    ].sort(),
    samples,
    artifacts,
    capabilities: [...capabilities].sort(),
    blockers: [],
    observedWorkload: options.measure
      ? {
          coldLaunchesPerAppearance: options.coldCount,
          alternatingPairs: options.pairCount,
          switches: options.pairCount * 2,
        }
      : { coldLaunchesPerAppearance: 1, alternatingPairs: 0, switches: 0 },
    runtimeVersion,
  };
}
