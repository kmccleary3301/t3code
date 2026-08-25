import type { WorkLogEntry } from "./session-logic.ts";

type NativeTerminalFallback = NonNullable<WorkLogEntry["nativeTerminalFallback"]>;

export interface NativeTerminalLaunchPlan {
  readonly terminalId: string;
  readonly command: "pi" | "omp";
}

export function nativeTerminalLaunchPlan(
  fallback: NativeTerminalFallback,
): NativeTerminalLaunchPlan {
  const instanceSegment = fallback.providerInstanceId
    .replaceAll(/[^A-Za-z0-9_-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 80);
  return {
    terminalId: `native-${fallback.runtime}-${instanceSegment || "provider"}`,
    command: fallback.runtime,
  };
}
