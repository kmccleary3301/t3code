/// <reference lib="dom" />
interface EvidenceInstrumentationState {
  readonly snapshot: () => unknown;
}
declare global {
  interface Window {
    readonly __T3_APPEARANCE_EVIDENCE__?: EvidenceInstrumentationState;
  }
}

import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";
import { redactActualSurfaceLog } from "./actual-surface-environment.ts";

export const APPEARANCE_MODES = ["light", "dark"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

const CapabilityStatus = Schema.Literals(["available", "unavailable"]);
const CapabilitySchema = Schema.Struct({
  status: CapabilityStatus,
  reason: Schema.optionalKey(Schema.String),
});
const LongTaskSchema = Schema.Struct({
  duration: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  startTime: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});
export const InstrumentationSnapshotSchema = Schema.Struct({
  reactCommits: Schema.Array(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  longTasks: Schema.Array(LongTaskSchema),
  appearanceOperations: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["compile", "stylesheet-replacement"]),
      startTime: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      duration: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
  sampledAt: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  dropped: Schema.Struct({
    reactCommits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    longTasks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    appearanceOperations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  capabilities: Schema.Struct({
    reactDevtools: CapabilitySchema,
    longTasks: CapabilitySchema,
  }),
});
export type InstrumentationSnapshot = typeof InstrumentationSnapshotSchema.Type;
export type InstrumentationCapability = typeof CapabilityStatus.Type;

export interface SurfaceReadiness {
  readonly url: string;
  readonly themeLibraryCards: number;
  readonly fontsReady: boolean;
  readonly animationFrames: number;
  readonly resolvedAppearance: AppearanceMode;
}

export type StylesheetRecordKind = "document" | "adopted" | "managed-fallback";

export const StylesheetRecordSchema = Schema.Struct({
  kind: Schema.Literals(["document", "adopted", "managed-fallback"]),
  href: Schema.NullOr(Schema.String),
  ruleCount: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  readable: Schema.Boolean,
});
export type StylesheetRecord = typeof StylesheetRecordSchema.Type;

export const StylesheetProbeSchema = Schema.Struct({
  records: Schema.Array(StylesheetRecordSchema),
  hasDuplicateAdoptedSheet: Schema.Boolean,
});
export type StylesheetProbe = typeof StylesheetProbeSchema.Type;

export const StylesheetMetricsSchema = Schema.Struct({
  ordinaryDocumentSheets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  adoptedConstructableSheets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  managedFallbackAppearanceStyles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type StylesheetMetrics = typeof StylesheetMetricsSchema.Type;
const decodeInstrumentationSnapshot = Schema.decodeUnknownSync(InstrumentationSnapshotSchema);
const decodeStylesheetProbeValue = Schema.decodeUnknownSync(StylesheetProbeSchema);

export function stylesheetMetricsFromProbe(probe: StylesheetProbe): StylesheetMetrics {
  const decoded = decodeStylesheetProbeValue(probe);
  if (decoded.hasDuplicateAdoptedSheet) {
    throw new Error("Duplicate adopted appearance stylesheet cannot pass the stylesheet metric.");
  }
  const ordinaryDocumentSheets = decoded.records.filter(
    (record) => record.kind === "document" || record.kind === "managed-fallback",
  ).length;
  const adoptedConstructableSheets = decoded.records.filter(
    (record) => record.kind === "adopted",
  ).length;
  const managedFallbackAppearanceStyles = decoded.records.filter(
    (record) => record.kind === "managed-fallback",
  ).length;
  if (managedFallbackAppearanceStyles > 1) {
    throw new Error(
      "Multiple managed fallback appearance styles cannot pass the stylesheet metric.",
    );
  }
  return {
    ordinaryDocumentSheets,
    adoptedConstructableSheets,
    managedFallbackAppearanceStyles,
    total: ordinaryDocumentSheets + adoptedConstructableSheets,
  };
}

/**
 * Keep the fallback style in the document-sheet inventory. It is marked rather
 * than appended separately, so the total cannot count it twice.
 */
export const STYLESHEET_PROBE_SCRIPT = `(() => {
  const fallbackElements = [
    ...document.querySelectorAll("style[data-t3-appearance-atomic]"),
  ];
  const fallbackSheets = new Set();
  for (const element of fallbackElements) {
    if (element.sheet) fallbackSheets.add(element.sheet);
  }
  const documentSheets = [...document.styleSheets];
  const adoptedSheets =
    "adoptedStyleSheets" in document ? [...document.adoptedStyleSheets] : [];
  const seenAdoptedSheets = new Set();
  let hasDuplicateAdoptedSheet = false;
  for (const sheet of adoptedSheets) {
    if (seenAdoptedSheets.has(sheet)) hasDuplicateAdoptedSheet = true;
    seenAdoptedSheets.add(sheet);
  }
  const describe = (sheet, kind) => {
    let ruleCount = null;
    let readable = true;
    try {
      ruleCount = sheet.cssRules?.length ?? 0;
    } catch {
      readable = false;
    }
    return {
      kind,
      href: sheet.href ?? null,
      ruleCount,
      readable,
    };
  };
  return {
    records: [
      ...documentSheets.map((sheet) =>
        describe(sheet, fallbackSheets.has(sheet) ? "managed-fallback" : "document"),
      ),
      ...adoptedSheets.map((sheet) => describe(sheet, "adopted")),
    ],
    hasDuplicateAdoptedSheet,
  };
})()`;

export interface SurfaceEvidence {
  readonly readiness: SurfaceReadiness;
  readonly instrumentation: InstrumentationSnapshot;
  readonly stylesheetInventory: ReadonlyArray<StylesheetRecord>;
  readonly stylesheetMetrics: StylesheetMetrics;
  readonly dom: string;
  readonly styles: string;
  readonly ariaSnapshot: string;
  readonly console: ReadonlyArray<string>;
  readonly screenshot: Uint8Array;
  readonly rendererMemoryBytes: number | null;
}

/** Web installs this before navigation; desktop installs it after shell readiness for warm-switch metrics only. */
export const APPEARANCE_INSTRUMENTATION_INIT_SCRIPT = `(() => {
  const key = "__T3_APPEARANCE_EVIDENCE__";
  if (window[key]) return;
  const makeRing = (limit) => {
    const entries = [];
    let start = 0;
    let dropped = 0;
    return Object.freeze({
      push: (entry) => {
        if (entries.length < limit) {
          entries.push(entry);
          return;
        }
        entries[start] = entry;
        start = (start + 1) % limit;
        dropped += 1;
      },
      snapshot: () =>
        start === 0
          ? entries.map((entry) => ({ ...entry }))
          : [...entries.slice(start), ...entries.slice(0, start)].map((entry) => ({ ...entry })),
      dropped: () => dropped,
    });
  };
  const reactCommits = makeRing(512);
  const longTasks = makeRing(512);
  const appearanceOperations = makeRing(512);
  const capabilities = {
    reactDevtools: { status: "available" },
    longTasks: { status: "available" },
  };
  const snapshot = Object.freeze({
    snapshot: () => ({
      reactCommits: reactCommits.snapshot().map((entry) => entry.at),
      longTasks: longTasks.snapshot(),
      appearanceOperations: appearanceOperations.snapshot(),
      sampledAt: performance.now(),
      capabilities: {
        reactDevtools: { ...capabilities.reactDevtools },
        longTasks: { ...capabilities.longTasks },
      },
      dropped: {
        reactCommits: reactCommits.dropped(),
        longTasks: longTasks.dropped(),
        appearanceOperations: appearanceOperations.dropped(),
      },
    }),
  });
  Object.defineProperty(window, key, {
    configurable: false,
    enumerable: false,
    value: snapshot,
    writable: false,
  });
  const sink = Object.freeze({
    begin: (kind) => {
      if (kind !== "compile" && kind !== "stylesheet-replacement") return () => {};
      const startTime = performance.now();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        appearanceOperations.push({
          kind,
          startTime,
          duration: Math.max(0, performance.now() - startTime),
        });
      };
    },
  });
  Object.defineProperty(window, "__T3_APPEARANCE_PERFORMANCE__", {
    configurable: false,
    enumerable: false,
    value: sink,
    writable: false,
  });
  const recordCommit = () => {
    reactCommits.push({ at: performance.now() });
  };
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && typeof hook.onCommitFiberRoot === "function") {
    const previousCommit = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (...args) {
      recordCommit();
      return previousCommit.apply(this, args);
    };
  } else if (hook && typeof hook.inject === "function") {
    hook.onCommitFiberRoot = recordCommit;
    if (typeof hook.onCommitFiberUnmount !== "function") hook.onCommitFiberUnmount = () => {};
  } else {
    const devtoolsHook = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: recordCommit,
      onCommitFiberUnmount: () => {},
    };
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      enumerable: false,
      value: devtoolsHook,
      writable: true,
    });
  }
  if (typeof PerformanceObserver !== "function") {
    capabilities.longTasks = {
      status: "unavailable",
      reason: "PerformanceObserver is unavailable.",
    };
  } else {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ duration: entry.duration, startTime: entry.startTime });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch (error) {
      capabilities.longTasks = {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "longtask observation failed",
      };
    }
  }
})();`;

export async function installAppearanceInstrumentation(page: Page): Promise<void> {
  await page.addInitScript({ content: APPEARANCE_INSTRUMENTATION_INIT_SCRIPT });
}

export async function readInstrumentationSnapshot(page: Page): Promise<InstrumentationSnapshot> {
  const raw = await page.evaluate(() => {
    const state = window.__T3_APPEARANCE_EVIDENCE__;
    if (!state) throw new Error("Appearance evidence instrumentation was not installed.");
    return state.snapshot();
  });
  return decodeInstrumentationSnapshot(raw);
}
export function decodeStylesheetProbe(raw: unknown): StylesheetProbe {
  return decodeStylesheetProbeValue(raw);
}

export async function readStylesheetProbe(page: Page): Promise<StylesheetProbe> {
  return decodeStylesheetProbe(await page.evaluate(STYLESHEET_PROBE_SCRIPT));
}

async function waitForAnimationFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function isAppearanceRoute(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname === "/settings/appearance" || parsed.hash.includes("/settings/appearance")
    );
  } catch {
    return false;
  }
}

export async function waitForAppearanceSurface(page: Page): Promise<SurfaceReadiness> {
  try {
    await page.waitForFunction(
      () => {
        const routeReady =
          window.location.pathname === "/settings/appearance" ||
          window.location.hash.includes("/settings/appearance");
        return routeReady && document.querySelectorAll("[data-theme-library-card]").length > 0;
      },
      undefined,
      { timeout: 15_000 },
    );
  } catch (error) {
    const url = page.url();
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .then((text) => text.slice(0, 1_000))
      .catch(() => "");
    throw new Error(
      `Appearance surface readiness timed out: ${redactActualSurfaceLog(JSON.stringify({ url, bodyText }))}`,
      { cause: error },
    );
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await waitForAnimationFrames(page, 2);
  const readiness = await page.evaluate(() => ({
    url: window.location.href,
    themeLibraryCards: document.querySelectorAll("[data-theme-library-card]").length,
    fontsReady: document.fonts.status === "loaded",
    resolvedAppearance: document.documentElement.classList.contains("dark") ? "dark" : "light",
  }));
  if (!isAppearanceRoute(readiness.url)) {
    throw new Error("Real /settings/appearance route was not ready.");
  }
  if (readiness.themeLibraryCards < 1 || !readiness.fontsReady) {
    throw new Error("Appearance readiness requires theme cards and document.fonts.ready.");
  }
  if (readiness.resolvedAppearance !== "light" && readiness.resolvedAppearance !== "dark") {
    throw new Error("Appearance readiness resolved an unsupported appearance.");
  }
  const resolvedAppearance: AppearanceMode =
    readiness.resolvedAppearance === "dark" ? "dark" : "light";
  return { ...readiness, resolvedAppearance, animationFrames: 2 };
}

export async function switchAppearance(
  page: Page,
  appearance: AppearanceMode,
): Promise<{
  readonly elapsedMs: number;
  readonly before: InstrumentationSnapshot;
  readonly after: InstrumentationSnapshot;
}> {
  const before = await readInstrumentationSnapshot(page);
  const started = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: `Use ${appearance} mode`, exact: true }).click();
  await page.waitForFunction(
    (expected) => document.documentElement.classList.contains("dark") === (expected === "dark"),
    appearance,
  );
  await waitForAnimationFrames(page, 2);
  const ended = await page.evaluate(() => performance.now());
  const after = await readInstrumentationSnapshot(page);
  return { elapsedMs: Math.max(0, ended - started), before, after };
}

function safeStylesheetHref(href: string | null): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return href.replace(/[?#][^\\s]*/gu, "");
  }
}

export async function collectSurfaceEvidence(
  page: Page,
  readiness: SurfaceReadiness,
  consoleMessages: ReadonlyArray<string>,
  stylesheetProbe?: StylesheetProbe,
): Promise<SurfaceEvidence> {
  const probe = stylesheetProbe ?? (await readStylesheetProbe(page));
  const stylesheetMetrics = stylesheetMetricsFromProbe(probe);
  const pageData = await page.evaluate(() => {
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
    const selectors = ["html", "body", "[data-theme-library-card]"];
    const styles = selectors
      .map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return `${selector}:missing`;
        const computed = getComputedStyle(element);
        return `${selector}:{${styleProperties.map((property) => `${property}:${computed.getPropertyValue(property).trim()}`).join(";")}}`;
      })
      .join("\n");
    const clone = document.documentElement.cloneNode(true);
    if (!(clone instanceof HTMLElement)) throw new Error("Could not clone document for evidence.");
    for (const element of clone.querySelectorAll("script,noscript,iframe,canvas")) element.remove();
    const sensitiveName = /token|secret|password|credential|authorization|api[-_]?key/iu;
    for (const element of clone.querySelectorAll("*")) {
      const identifiesSensitiveField = ["name", "id", "aria-label", "data-testid"].some((name) =>
        sensitiveName.test(element.getAttribute(name) ?? ""),
      );
      if (identifiesSensitiveField) element.textContent = "[REDACTED]";
      for (
        let attributeIndex = element.attributes.length - 1;
        attributeIndex >= 0;
        attributeIndex -= 1
      ) {
        const attribute = element.attributes.item(attributeIndex);
        if (attribute === null) continue;
        if (sensitiveName.test(attribute.name) || sensitiveName.test(attribute.value)) {
          element.removeAttribute(attribute.name);
        } else if (attribute.name === "value") {
          element.setAttribute(attribute.name, "");
        } else if (attribute.name === "href" || attribute.name === "src") {
          try {
            const parsed = new URL(attribute.value, document.baseURI);
            element.setAttribute(attribute.name, `${parsed.origin}${parsed.pathname}`);
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
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
        .replace(
          /((?:token|secret|password|credential|authorization|api[-_]?key)\s*[=:]\s*)[^\s,;}]+/giu,
          "$1[REDACTED]",
        );
    }
    const rendererPerformance = performance as Performance & {
      readonly memory?: { readonly usedJSHeapSize?: number };
    };
    const memory = rendererPerformance.memory?.usedJSHeapSize;
    return {
      styles,
      dom: clone.outerHTML,
      rendererMemoryBytes: typeof memory === "number" && Number.isFinite(memory) ? memory : null,
    };
  });
  const ariaSnapshot = await page.locator("body").ariaSnapshot();
  const screenshot = await page.screenshot({ type: "png" });
  return {
    readiness,
    instrumentation: await readInstrumentationSnapshot(page),
    stylesheetInventory: probe.records.map((sheet) => ({
      ...sheet,
      href: safeStylesheetHref(sheet.href),
    })),
    stylesheetMetrics,
    dom: redactActualSurfaceLog(pageData.dom),
    styles: redactActualSurfaceLog(pageData.styles),
    ariaSnapshot: redactActualSurfaceLog(ariaSnapshot),
    console: consoleMessages.map((message) => redactActualSurfaceLog(message)),
    screenshot,
    rendererMemoryBytes: pageData.rendererMemoryBytes,
  };
}

export function metricDelta(
  before: InstrumentationSnapshot,
  after: InstrumentationSnapshot,
): {
  readonly reactCommits: number;
  readonly maxLongTaskDurationMs: number;
  readonly compileDurationMs: number;
  readonly stylesheetReplacementDurationMs: number;
} {
  const inWindow = (startTime: number) =>
    startTime >= before.sampledAt && startTime <= after.sampledAt;
  const newTasks = after.longTasks.filter((entry) => inWindow(entry.startTime));
  const operations = after.appearanceOperations.filter((entry) => inWindow(entry.startTime));
  return {
    reactCommits: after.reactCommits.filter(inWindow).length,
    maxLongTaskDurationMs: newTasks.reduce(
      (maximum, entry) => Math.max(maximum, entry.duration),
      0,
    ),
    compileDurationMs: operations
      .filter((entry) => entry.kind === "compile")
      .reduce((total, entry) => total + entry.duration, 0),
    stylesheetReplacementDurationMs: operations
      .filter((entry) => entry.kind === "stylesheet-replacement")
      .reduce((total, entry) => total + entry.duration, 0),
  };
}
