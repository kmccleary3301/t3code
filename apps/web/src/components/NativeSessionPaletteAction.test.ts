import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderNativeSessionSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { resolveNativeSessionLoadOutcome } from "./NativeSessionPaletteAction";

const decodeSummary = Schema.decodeUnknownSync(ProviderNativeSessionSummary);

function target(environmentId: string, providerInstanceId: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(providerInstanceId),
    driver: ProviderDriverKind.make("omp"),
    displayName: providerInstanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const [entry] = deriveProviderInstanceEntries([provider]);
  if (entry === undefined) throw new Error("Expected provider entry");
  return {
    environmentId: EnvironmentId.make(environmentId),
    environmentLabel: environmentId,
    entry,
  };
}

function summary(sessionId: string, updatedAt: string) {
  return decodeSummary({
    providerInstanceId: "omp",
    runtime: "omp",
    sessionId,
    cwd: "/workspace",
    title: sessionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    status: "complete",
  });
}

describe("resolveNativeSessionLoadOutcome", () => {
  it("keeps partial successes and sorts sessions across targets", () => {
    const local = target("local", "omp-local");
    const remote = target("remote", "omp-remote");

    const outcome = resolveNativeSessionLoadOutcome([
      {
        target: local,
        sessions: [summary("older", "2026-01-01T00:00:00.000Z")],
      },
      { target: remote, error: "remote unavailable" },
      {
        target: local,
        sessions: [summary("newer", "2026-01-02T00:00:00.000Z")],
      },
    ]);

    expect(outcome.status).toBe("partial");
    expect(outcome.sessions.map(({ session }) => session.sessionId)).toEqual(["newer", "older"]);
    expect(outcome.errors).toEqual(["remote unavailable"]);
  });

  it("distinguishes all-target failure from a successful empty catalog", () => {
    const local = target("local", "omp-local");

    expect(resolveNativeSessionLoadOutcome([{ target: local, error: "offline" }]).status).toBe(
      "failure",
    );
    expect(resolveNativeSessionLoadOutcome([{ target: local, sessions: [] }]).status).toBe(
      "success",
    );
  });
});
