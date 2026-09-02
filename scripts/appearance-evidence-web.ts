/// <reference lib="dom" />
// @effect-diagnostics nodeBuiltinImport:off - Evidence drivers own disposable host filesystem state.
import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from "playwright-core";

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
interface NetworkRequestObservation {
  failure: string | null;
  method: string;
  outcome: "pending" | "response" | "failed";
  resourceType: string;
  status: number | null;
  url: string;
}
const MAX_CONSOLE_ENTRIES = 512;
const MAX_NETWORK_ENTRIES = 2_048;
const MAX_EVIDENCE_TEXT_BYTES = 4_096;
class EvidenceRing<T> {
  readonly #entries: T[] = [];
  #dropped = 0;
  #start = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get dropped(): number {
    return this.#dropped;
  }

  clear(): void {
    this.#entries.length = 0;
    this.#dropped = 0;
    this.#start = 0;
  }

  push(entry: T): void {
    if (this.#entries.length < this.#limit) {
      this.#entries.push(entry);
      return;
    }
    this.#entries[this.#start] = entry;
    this.#start = (this.#start + 1) % this.#limit;
    this.#dropped += 1;
  }

  snapshot(): ReadonlyArray<T> {
    if (this.#start === 0) return [...this.#entries];
    return [...this.#entries.slice(this.#start), ...this.#entries.slice(0, this.#start)];
  }
}
function boundedEvidenceText(value: string): string {
  const bytes = NodeBuffer.Buffer.from(value);
  if (bytes.byteLength <= MAX_EVIDENCE_TEXT_BYTES) return value;
  const truncated = bytes.subarray(0, MAX_EVIDENCE_TEXT_BYTES).toString("utf8");
  return `${truncated.endsWith("\uFFFD") ? truncated.slice(0, -1) : truncated}[truncated]`;
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
function sanitizedNetworkUrl(value: string, credential: string | undefined): string {
  try {
    const parsed = new URL(value);
    return boundedEvidenceText(
      redactActualSurfaceLog(`${parsed.origin}${parsed.pathname}`, credential ? [credential] : []),
    );
  } catch {
    return boundedEvidenceText(redactActualSurfaceLog(value, credential ? [credential] : []));
  }
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
  readonly messages: EvidenceRing<string>;
  readonly networkRequests: EvidenceRing<NetworkRequestObservation>;
  readonly coldStartupMs: number;
  readonly dispose: () => Promise<void>;
}> {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "appearance-web-"));
  let environment: Awaited<ReturnType<typeof createActualSurfaceEnvironment>> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let credential: string | undefined;
  const messages = new EvidenceRing<string>(MAX_CONSOLE_ENTRIES);
  const networkRequests = new EvidenceRing<NetworkRequestObservation>(MAX_NETWORK_ENTRIES);
  const requests = new WeakMap<Request, NetworkRequestObservation>();
  let observationStage = "actual-surface-environment";
  const responseFailures = new EvidenceRing<string>(128);
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
    page.on("console", (message) =>
      messages.push(boundedEvidenceText(`${message.type()}: ${message.text()}`)),
    );
    page.on("pageerror", (error) =>
      messages.push(boundedEvidenceText(`pageerror: ${error.message}`)),
    );
    page.on("request", (request) => {
      const observation: NetworkRequestObservation = {
        failure: null,
        method: boundedEvidenceText(request.method()),
        outcome: "pending",
        resourceType: boundedEvidenceText(request.resourceType()),
        status: null,
        url: sanitizedNetworkUrl(request.url(), credential),
      };
      requests.set(request, observation);
      networkRequests.push(observation);
    });
    page.on("requestfailed", (request) => {
      const observation = requests.get(request);
      if (observation !== undefined) {
        observation.outcome = "failed";
        observation.failure = boundedEvidenceText(
          redactActualSurfaceLog(
            request.failure()?.errorText ?? "unknown request failure",
            credential ? [credential] : [],
          ),
        );
      }
      responseFailures.push(
        boundedEvidenceText(
          `request failed: ${redactActualSurfaceLog(request.url(), credential ? [credential] : [])}`,
        ),
      );
    });
    page.on("response", (response) => {
      const request = response.request();
      const observation = requests.get(request);
      if (observation !== undefined) {
        observation.outcome = "response";
        observation.status = response.status();
      }
      if (response.status() < 400) return;
      responseFailures.push(
        boundedEvidenceText(
          `response ${response.status()}: ${redactActualSurfaceLog(response.url(), credential ? [credential] : [])}`,
        ),
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
    messages.clear();
    responseFailures.clear();
    networkRequests.clear();
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
      networkRequests,
      coldStartupMs: performance.now() - clientStarted,
      dispose,
    };
  } catch (error) {
    const secrets = credential ? [credential] : [];
    const causeMessage = redactActualSurfaceLog(
      error instanceof Error ? error.message : String(error),
      secrets,
    );
    const diagnostic = [...responseFailures.snapshot(), ...messages.snapshot().slice(-10)]
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
        const consoleMessages = session.messages.snapshot();
        const evidence = await collectSurfaceEvidence(
          session.page,
          readiness,
          session.messages.dropped === 0
            ? consoleMessages
            : [
                `evidence: ${session.messages.dropped} earlier console entries dropped`,
                ...consoleMessages,
              ],
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
            path: `${visualRoot}/network-requests.json`,
            content: json({
              dropped: session.networkRequests.dropped,
              requests: session.networkRequests.snapshot(),
            }),
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
