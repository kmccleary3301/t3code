/// <reference lib="dom" />
interface EvidenceInstrumentationState {
  readonly reactCommits: ReadonlyArray<number>;
  readonly longTasks: ReadonlyArray<{ readonly duration: number; readonly startTime: number }>;
  readonly capabilities: {
    readonly reactDevtools: {
      readonly status: "available" | "unavailable";
      readonly reason?: string;
    };
    readonly longTasks: { readonly status: "available" | "unavailable"; readonly reason?: string };
  };
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

export interface StylesheetRecord {
  readonly href: string | null;
  readonly ruleCount: number | null;
  readonly readable: boolean;
}

export interface SurfaceEvidence {
  readonly readiness: SurfaceReadiness;
  readonly instrumentation: InstrumentationSnapshot;
  readonly stylesheetInventory: ReadonlyArray<StylesheetRecord>;
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
  const existing = window[key];
  if (existing) return;
  const state = {
    reactCommits: [],
    longTasks: [],
    capabilities: {
      reactDevtools: { status: "available" },
      longTasks: { status: "available" },
    },
  };
  window[key] = state;
  const recordCommit = () => {
    state.reactCommits.push(performance.now());
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
    state.capabilities.longTasks = { status: "unavailable", reason: "PerformanceObserver is unavailable." };
  } else {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch (error) {
      state.capabilities.longTasks = {
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
    return {
      reactCommits: [...state.reactCommits],
      longTasks: state.longTasks.map((entry) => ({ ...entry })),
      capabilities: {
        reactDevtools: { ...state.capabilities.reactDevtools },
        longTasks: { ...state.capabilities.longTasks },
      },
    };
  });
  return Schema.decodeUnknownSync(InstrumentationSnapshotSchema)(raw);
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
): Promise<SurfaceEvidence> {
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
      for (const attribute of [...element.attributes]) {
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
      stylesheets: [...document.styleSheets].map((sheet) => {
        let ruleCount: number | null = null;
        let readable = true;
        try {
          ruleCount = sheet.cssRules?.length ?? 0;
        } catch {
          readable = false;
        }
        return { href: sheet.href, ruleCount, readable };
      }),
      rendererMemoryBytes: typeof memory === "number" && Number.isFinite(memory) ? memory : null,
    };
  });
  const ariaSnapshot = await page.locator("body").ariaSnapshot();
  const screenshot = await page.screenshot({ type: "png" });
  return {
    readiness,
    instrumentation: await readInstrumentationSnapshot(page),
    stylesheetInventory: pageData.stylesheets.map((sheet) => ({
      ...sheet,
      href: safeStylesheetHref(sheet.href),
    })),
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
} {
  const start = before.longTasks.length;
  const newTasks = after.longTasks.slice(start);
  return {
    reactCommits: Math.max(0, after.reactCommits.length - before.reactCommits.length),
    maxLongTaskDurationMs: newTasks.reduce(
      (maximum, entry) => Math.max(maximum, entry.duration),
      0,
    ),
  };
}
