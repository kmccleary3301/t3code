import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderNativeSessionSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectNativeSessionTargets,
  filterNativeSessionItems,
  nativeSessionCommandTarget,
  type NativeSessionItem,
} from "./nativeSessionList";

function session(
  runtime: "pi" | "omp",
  overrides: Partial<ProviderNativeSessionSummary> = {},
): ProviderNativeSessionSummary {
  return {
    providerInstanceId: ProviderInstanceId.make(runtime),
    runtime,
    sessionId: `${runtime}-session`,
    cwd: `/workspace/${runtime}`,
    title: `${runtime.toUpperCase()} work`,
    model: "gpt-5.6",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:01:00.000Z",
    status: "complete",
    ...overrides,
  };
}

const items: ReadonlyArray<NativeSessionItem> = [
  {
    environmentId: EnvironmentId.make("remote-mac"),
    environmentLabel: "Mac Studio",
    providerInstanceId: ProviderInstanceId.make("pi"),
    providerLabel: "Pi Personal",
    session: session("pi"),
  },
  {
    environmentId: EnvironmentId.make("remote-linux"),
    environmentLabel: "Linux Host",
    providerInstanceId: ProviderInstanceId.make("omp"),
    providerLabel: "Oh My Pi",
    session: session("omp", { status: "interrupted" }),
  },
];

describe("filterNativeSessionItems", () => {
  it("matches runtime, workspace, provider, environment, model, and status", () => {
    expect(filterNativeSessionItems(items, "PI work")).toHaveLength(1);
    expect(filterNativeSessionItems(items, "/workspace/omp")).toHaveLength(1);
    expect(filterNativeSessionItems(items, "personal")).toHaveLength(1);
    expect(filterNativeSessionItems(items, "linux host")).toHaveLength(1);
    expect(filterNativeSessionItems(items, "gpt-5.6")).toHaveLength(2);
    expect(filterNativeSessionItems(items, "interrupted")).toHaveLength(1);
  });

  it("returns all sessions for a blank query", () => {
    expect(filterNativeSessionItems(items, "   ")).toBe(items);
  });
});

describe("native session remote routing", () => {
  it("discovers only available Pi-family providers on connected environments", () => {
    const remoteMac = EnvironmentId.make("remote-mac");
    const offlineLinux = EnvironmentId.make("offline-linux");
    const targets = collectNativeSessionTargets(
      [
        { environmentId: remoteMac, connectionState: "connected" },
        { environmentId: offlineLinux, connectionState: "disconnected" },
      ],
      new Map([
        [
          remoteMac,
          {
            providers: [
              {
                instanceId: ProviderInstanceId.make("pi-personal"),
                driver: "pi",
                enabled: true,
                installed: true,
                displayName: "Pi Personal",
              },
              {
                instanceId: ProviderInstanceId.make("omp-work"),
                driver: "omp",
                enabled: false,
                installed: true,
              },
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: "codex",
                enabled: true,
                installed: true,
              },
            ],
          },
        ],
        [
          offlineLinux,
          {
            providers: [
              {
                instanceId: ProviderInstanceId.make("omp"),
                driver: "omp",
                enabled: true,
                installed: true,
              },
            ],
          },
        ],
      ]),
      { [remoteMac]: { environmentLabel: "Mac Studio" } },
    );

    expect(targets).toEqual([
      {
        environmentId: remoteMac,
        environmentLabel: "Mac Studio",
        providerInstanceId: ProviderInstanceId.make("pi-personal"),
        providerLabel: "Pi Personal",
      },
    ]);
  });

  it("routes lifecycle commands to the session's remote environment and provider", () => {
    expect(nativeSessionCommandTarget(items[1]!)).toEqual({
      environmentId: EnvironmentId.make("remote-linux"),
      input: {
        providerInstanceId: ProviderInstanceId.make("omp"),
        sessionId: "omp-session",
      },
    });
  });
});
