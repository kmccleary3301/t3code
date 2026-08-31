import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderNativeSessionSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectNativeSessionTargets,
  filterNativeSessionItems,
  nativeSessionCommandTarget,
  nativeSessionItemKey,
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
        {
          environmentId: remoteMac,
          environmentLabel: "Mac Studio",
          connectionState: "connected",
        },
        {
          environmentId: offlineLinux,
          environmentLabel: "Offline Linux",
          connectionState: "offline",
        },
      ],
      new Map([
        [
          remoteMac,
          {
            providers: [
              {
                instanceId: ProviderInstanceId.make("pi-personal"),
                driver: ProviderDriverKind.make("pi"),
                enabled: true,
                installed: true,
                displayName: "Pi Personal",
              },
              {
                instanceId: ProviderInstanceId.make("omp-work"),
                driver: ProviderDriverKind.make("omp"),
                enabled: false,
                installed: true,
              },
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: ProviderDriverKind.make("codex"),
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
                driver: ProviderDriverKind.make("omp"),
                enabled: true,
                installed: true,
              },
            ],
          },
        ],
      ]),
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

  it("uses one stable key for card busy state and duplicate-operation guards", () => {
    expect(nativeSessionItemKey(items[1]!)).toBe("remote-linux:omp:omp-session");
  });
});
