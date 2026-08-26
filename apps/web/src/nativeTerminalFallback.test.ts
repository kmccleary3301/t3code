import { describe, expect, it } from "@effect/vitest";

import { nativeTerminalLaunchPlan } from "./nativeTerminalFallback.ts";

describe("native terminal fallback", () => {
  it("allocates one stable provider terminal and the actual native command", () => {
    const fallback = {
      runtime: "omp" as const,
      providerInstanceId: "OMP main/profile",
      feature: "setTitle",
    };

    expect(nativeTerminalLaunchPlan(fallback)).toEqual({
      terminalId: "native-omp-OMP-main-profile",
      command: "omp",
    });
    expect(nativeTerminalLaunchPlan(fallback)).toEqual(nativeTerminalLaunchPlan(fallback));
  });

  it("keeps Pi and OMP provider terminals isolated", () => {
    expect(
      nativeTerminalLaunchPlan({
        runtime: "pi",
        providerInstanceId: "main",
        feature: "open",
      }),
    ).toEqual({ terminalId: "native-pi-main", command: "pi" });
    expect(
      nativeTerminalLaunchPlan({
        runtime: "omp",
        providerInstanceId: "main",
        feature: "open",
      }),
    ).toEqual({ terminalId: "native-omp-main", command: "omp" });
  });
});
