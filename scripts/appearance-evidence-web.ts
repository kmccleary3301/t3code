/// <reference lib="dom" />
// @effect-diagnostics nodeBuiltinImport:off - Evidence drivers own disposable host filesystem state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import {
  createActualSurfaceChildEnv,
  createActualSurfaceEnvironment,
  redactActualSurfaceLog,
} from "./actual-surface-environment.ts";
import {
  collectSurfaceEvidence,
  installAppearanceInstrumentation,
  metricDelta,
  readInstrumentationSnapshot,
  readStylesheetProbe,
  stylesheetMetricsFromProbe,
  switchAppearance,
  waitForAppearanceSurface,
  type AppearanceMode,
  type StylesheetProbe,
} from "./appearance-evidence-playwright.ts";
import type { MetricSample } from "./appearance-evidence.ts";

export interface DriverArtifact {
  readonly path: string;
  readonly content: Uint8Array | string;
}
export interface AppearanceDriverResult {
  readonly status: "complete" | "blocked";
  readonly client: "web" | "desktop";
  readonly cards: ReadonlyArray<string>;
  readonly samples: ReadonlyArray<MetricSample>;
  readonly artifacts: ReadonlyArray<DriverArtifact>;
  readonly capabilities: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<string>;
  readonly observedWorkload: {
    readonly coldLaunchesPerAppearance: number;
    readonly alternatingPairs: number;
    readonly switches: number;
  };
  readonly runtimeVersion: string;
}
export interface WebDriverOptions {
  readonly chromiumExecutable: string;
  readonly measure: boolean;
  readonly coldCount: number;
  readonly pairCount: number;
}
class WebAppearanceBlockedError extends Error {
  readonly code: string;
  readonly classification: "BLOCKED_PRODUCT" | "BLOCKED_INFRASTRUCTURE";
  readonly observationStage: string;

  constructor(
    code: string,
    classification: "BLOCKED_PRODUCT" | "BLOCKED_INFRASTRUCTURE",
    observationStage: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebAppearanceBlockedError";
    this.code = code;
    this.classification = classification;
    this.observationStage = observationStage;
  }
}

const MODE_STORAGE_KEY = "t3code:theme-appearance-mode";
const THEME_STORAGE_KEY = "t3code:theme";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function appearanceModeInitScript(appearance: AppearanceMode): string {
  return `(() => {
    localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)}, "t3-chat");
    localStorage.setItem(${JSON.stringify(MODE_STORAGE_KEY)}, ${JSON.stringify(appearance)});
  })();`;
}

async function openWebPage(
  options: WebDriverOptions,
  appearance: AppearanceMode,
): Promise<{
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly messages: ReadonlyArray<string>;
  readonly networkResponses: ReadonlyArray<{
    readonly resourceType: string;
    readonly status: number;
    readonly url: string;
  }>;
  readonly coldStartupMs: number;
  readonly dispose: () => Promise<void>;
}> {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "appearance-web-"));
  let environment: Awaited<ReturnType<typeof createActualSurfaceEnvironment>> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let credential: string | undefined;
  const messages: string[] = [];
  const networkResponses: Array<{ resourceType: string; status: number; url: string }> = [];
  let observationStage = "actual-surface-environment";
  const responseFailures: string[] = [];
  const dispose = async (): Promise<void> => {
    const failures: unknown[] = [];
    const currentContext = context;
    const currentBrowser = browser;
    const currentEnvironment = environment;
    for (const close of [
      currentContext ? () => currentContext.close() : undefined,
      currentBrowser ? () => currentBrowser.close() : undefined,
      currentEnvironment ? () => currentEnvironment.dispose() : undefined,
    ]) {
      if (!close) continue;
      try {
        await close();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Web appearance client resources could not be fully stopped.",
      );
    }
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  };
  try {
    environment = await createActualSurfaceEnvironment({
      baseDir: NodePath.join(baseDir, "environment"),
      workspaceRoot: NodePath.join(baseDir, "environment", "workspace"),
      label: "appearance-web",
      temporaryRoot: true,
    });
    const browserHome = NodePath.join(baseDir, "browser-home");
    const browserTmp = NodePath.join(baseDir, "browser-tmp");
    await Promise.all([
      NodeFSP.mkdir(browserHome, { recursive: true, mode: 0o700 }),
      NodeFSP.mkdir(browserTmp, { recursive: true, mode: 0o700 }),
    ]);
    observationStage = "chromium-launch";
    const clientStarted = performance.now();
    browser = await chromium.launch({
      executablePath: options.chromiumExecutable,
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
      ],
      env: {
        ...createActualSurfaceChildEnv(NodeProcess.env, {
          HOME: browserHome,
          TMPDIR: browserTmp,
          NO_COLOR: "1",
        }),
      },
    });
    context = await browser.newContext();
    await context.addInitScript({ content: appearanceModeInitScript(appearance) });
    const page = await context.newPage();
    await installAppearanceInstrumentation(page);
    page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
    page.on("response", (response) => {
      const resourceType = response.request().resourceType();
      let url = response.url();
      try {
        const parsed = new URL(url);
        url = `${parsed.origin}${parsed.pathname}`;
      } catch {
        url = redactActualSurfaceLog(url, credential ? [credential] : []);
      }
      networkResponses.push({
        resourceType,
        status: response.status(),
        url,
      });
      if (response.status() < 400 && resourceType !== "fetch" && resourceType !== "xhr") return;
      responseFailures.push(
        `response ${response.status()}: ${redactActualSurfaceLog(response.url(), credential ? [credential] : [])}`,
      );
    });
    observationStage = "pairing-route";
    const pairingUrl = new URL(await environment.pairingUrl("127.0.0.1"));
    credential = new URLSearchParams(pairingUrl.hash.slice(1)).get("token") ?? undefined;
    if (!credential) throw new Error("Disposable pairing URL did not contain a credential.");
    pairingUrl.hash = "";
    const origin = pairingUrl.origin;
    await page.goto(pairingUrl.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    observationStage = "pairing-form";
    await page.getByLabel("Pairing token", { exact: true }).fill(credential);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 60_000 });
    messages.length = 0;
    responseFailures.length = 0;
    networkResponses.length = 0;
    observationStage = "settings-route";
    await page.goto(`${origin}/settings/appearance`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForAppearanceSurface(page);
    return {
      browser,
      context,
      page,
      messages,
      networkResponses,
      coldStartupMs: performance.now() - clientStarted,
      dispose,
    };
  } catch (error) {
    const secrets = credential ? [credential] : [];
    const causeMessage = redactActualSurfaceLog(
      error instanceof Error ? error.message : String(error),
      secrets,
    );
    const diagnostic = [...responseFailures, ...messages.slice(-10)]
      .map((message) => redactActualSurfaceLog(message, secrets))
      .join(" | ");
    try {
      await dispose();
    } catch (cleanupError) {
      const cleanupMessage = redactActualSurfaceLog(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        secrets,
      );
      throw new WebAppearanceBlockedError(
        "web-process-cleanup-failed",
        "BLOCKED_INFRASTRUCTURE",
        "cleanup",
        `Web evidence cleanup failed after '${causeMessage}': ${cleanupMessage}`,
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    const blocked =
      error instanceof WebAppearanceBlockedError
        ? error
        : new WebAppearanceBlockedError(
            observationStage === "actual-surface-environment" ||
              observationStage === "chromium-launch"
              ? "web-client-launch-failed"
              : "web-client-readiness-failed",
            observationStage === "actual-surface-environment" ||
              observationStage === "chromium-launch"
              ? "BLOCKED_INFRASTRUCTURE"
              : "BLOCKED_PRODUCT",
            observationStage,
            `Web evidence session failed: ${causeMessage}${diagnostic ? ` | ${diagnostic}` : ""}`,
            { cause: error },
          );
    throw blocked;
  }
}

async function rendererMemory(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const value = (
      performance as Performance & { readonly memory?: { readonly usedJSHeapSize?: number } }
    ).memory?.usedJSHeapSize;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
}

export async function runWebAppearanceDriver(
  options: WebDriverOptions,
): Promise<AppearanceDriverResult> {
  const samples: MetricSample[] = [];
  const artifacts: DriverArtifact[] = [];
  const capabilities = new Set<string>();
  let sampleIndex = 0;
  let runtimeVersion: string | undefined;
  const addSession = async (
    appearance: AppearanceMode,
    collectVisual: boolean,
    collectWarmSwitches: boolean,
  ): Promise<void> => {
    const session = await openWebPage(options, appearance);
    try {
      const observedRuntimeVersion = `Chromium ${session.browser.version()}`;
      if (runtimeVersion && runtimeVersion !== observedRuntimeVersion) {
        throw new Error("Chromium runtime changed during one evidence run.");
      }
      runtimeVersion = observedRuntimeVersion;
      const readiness = await waitForAppearanceSurface(session.page);
      if (readiness.resolvedAppearance !== appearance) {
        throw new Error(
          `Expected cold ${appearance} appearance, got ${readiness.resolvedAppearance}.`,
        );
      }
      samples.push({
        kind: "cold-startup",
        client: "web",
        appearance,
        value: session.coldStartupMs,
        unit: "ms",
        sampleIndex: sampleIndex++,
      });
      const instrumentation = await readInstrumentationSnapshot(session.page);
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
      const memory = await rendererMemory(session.page);
      if (memory === null) {
        capabilities.add("memory: performance.memory is unavailable");
      } else {
        samples.push({
          kind: "memory",
          client: "web",
          appearance,
          value: memory,
          unit: "bytes",
          sampleIndex: sampleIndex++,
        });
      }
      const stylesheetProbe: StylesheetProbe = await readStylesheetProbe(session.page);
      const stylesheetMetrics = stylesheetMetricsFromProbe(stylesheetProbe);
      samples.push({
        kind: "stylesheet-count",
        client: "web",
        appearance,
        value: stylesheetMetrics.total,
        unit: "count",
        sampleIndex: sampleIndex++,
      });
      if (collectVisual) {
        const evidence = await collectSurfaceEvidence(
          session.page,
          readiness,
          session.messages,
          stylesheetProbe,
        );
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
            path: `${visualRoot}/network-responses.json`,
            content: json(session.networkResponses),
          },
          {
            path: `${visualRoot}/stylesheet-metrics.json`,
            content: json(evidence.stylesheetMetrics),
          },
        );
      }
      if (collectWarmSwitches) {
        await switchAppearance(session.page, "light");
        for (let index = 0; index < options.pairCount * 2; index += 1) {
          const mode: AppearanceMode = index % 2 === 0 ? "dark" : "light";
          const switched = await switchAppearance(session.page, mode);
          const delta = metricDelta(switched.before, switched.after);
          samples.push(
            {
              kind: "warm-switch",
              client: "web",
              appearance: mode,
              value: switched.elapsedMs,
              unit: "ms",
              sampleIndex: index,
            },
            {
              kind: "react-commits",
              client: "web",
              appearance: mode,
              value: delta.reactCommits,
              unit: "count",
              sampleIndex: index + 10_000,
            },
            {
              kind: "long-task",
              client: "web",
              appearance: mode,
              value: delta.maxLongTaskDurationMs,
              unit: "ms",
              sampleIndex: index + 10_000,
            },
            {
              kind: "compiler",
              client: "web",
              appearance: mode,
              value: delta.compileDurationMs,
              unit: "ms",
              sampleIndex: index + 10_000,
            },
            {
              kind: "stylesheet-replacement",
              client: "web",
              appearance: mode,
              value: delta.stylesheetReplacementDurationMs,
              unit: "ms",
              sampleIndex: index + 10_000,
            },
          );
        }
      }
    } finally {
      await session.dispose();
    }
  };
  try {
    if (options.measure) {
      for (const appearance of ["light", "dark"] as const) {
        for (let index = 0; index < options.coldCount; index += 1) {
          await addSession(appearance, index === 0, appearance === "light" && index === 0);
        }
      }
    } else {
      await addSession("light", true, false);
      await addSession("dark", true, false);
    }
    if (!runtimeVersion) throw new Error("Chromium runtime identity was not observed.");
  } catch (cause) {
    const blocker =
      cause instanceof WebAppearanceBlockedError
        ? cause
        : new WebAppearanceBlockedError(
            "web-evidence-collection-failed",
            "BLOCKED_PRODUCT",
            "evidence-collection",
            cause instanceof Error ? cause.message : String(cause),
            { cause },
          );
    return {
      status: "blocked",
      client: "web",
      cards: [],
      samples: [],
      artifacts: [
        {
          path: `blockers/${blocker.code}.json`,
          content: json({
            schemaVersion: 1,
            code: blocker.code,
            classification: blocker.classification,
            observationStage: blocker.observationStage,
            message: blocker.message,
            runtimeVersion: runtimeVersion ?? "Chromium not observed",
          }),
        },
      ],
      capabilities: [],
      blockers: [blocker.code],
      observedWorkload: {
        coldLaunchesPerAppearance: 0,
        alternatingPairs: 0,
        switches: 0,
      },
      runtimeVersion: runtimeVersion ?? "Chromium not observed",
    };
  }
  return {
    status: "complete",
    client: "web",
    cards: [
      "appearance-dark",
      "appearance-light",
      "browser-local",
      "settings-theme-library",
      "theme-built-in",
    ],
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
