// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  listPiFamilyNativeSessions,
  readPiFamilyNativeHistoryMessages,
  resolvePiFamilySessionDirectory,
  type PiFamilySessionCatalogConfig,
} from "./NativeSessionCatalog.ts";

const temporaryDirectories: string[] = [];

function config(
  agentDirectory: string,
  runtime: PiFamilySessionCatalogConfig["runtime"] = "omp",
): PiFamilySessionCatalogConfig {
  return {
    runtime,
    cwd: "/workspace",
    agentDirectory,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("NativeSessionCatalog", () => {
  it("resolves explicit and environment session directories first", () => {
    const explicitConfig = {
      ...config("/agent"),
      launchArguments: ["--session-dir", "/sessions"],
    };
    expect(resolvePiFamilySessionDirectory(explicitConfig)).toBe("/sessions");

    const environmentConfig = {
      ...config("/agent", "pi"),
      environment: { PI_CODING_AGENT_SESSION_DIR: "/pi-sessions" },
    };
    expect(resolvePiFamilySessionDirectory(environmentConfig)).toBe("/pi-sessions");
  });

  it.effect("lists only top-level OMP sessions for the requested cwd", () =>
    Effect.gen(function* () {
      const temporaryDirectory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-catalog-")),
      );
      temporaryDirectories.push(temporaryDirectory);
      const sessionsDirectory = NodePath.join(temporaryDirectory, "sessions", "project");
      yield* Effect.promise(() => NodeFSP.mkdir(sessionsDirectory, { recursive: true }));
      const sessionPath = NodePath.join(sessionsDirectory, "session.jsonl");
      const lines = [
        { type: "title", title: "Existing OMP work" },
        {
          type: "session",
          id: "session-1",
          cwd: "/workspace",
          timestamp: "2026-08-01T12:00:00.000Z",
        },
        { type: "model_change", modelId: "gpt-5.6" },
        {
          type: "message",
          id: "current-user",
          parentId: "session-1",
          timestamp: "2026-08-01T12:00:01.000Z",
          message: { role: "user", content: "continue this" },
        },
        {
          type: "message",
          id: "current-assistant",
          parentId: "current-user",
          timestamp: "2026-08-01T12:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            model: "gpt-5.6",
          },
        },
      ];
      yield* Effect.promise(() =>
        NodeFSP.writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`),
      );
      const duplicatePath = NodePath.join(sessionsDirectory, "duplicate.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          duplicatePath,
          `${[
            { type: "session", id: "session-1", cwd: "/workspace", title: "Old duplicate" },
            {
              type: "message",
              id: "stale-user",
              parentId: "session-1",
              timestamp: "2025-01-01T00:00:00.000Z",
              message: { role: "user", content: "stale history" },
            },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n")}\n`,
        ),
      );
      yield* Effect.promise(() => NodeFSP.utimes(duplicatePath, 0, 0));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(sessionsDirectory, "corrupt.jsonl"),
          '{"type":"session","id":"corrupt","timestamp":"invalid"}\n',
        ),
      );
      const nestedDirectory = NodePath.join(sessionsDirectory, "session");
      yield* Effect.promise(() => NodeFSP.mkdir(nestedDirectory));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(nestedDirectory, "subagent.jsonl"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Exact JSONL native session fixture.
          `${JSON.stringify({ type: "session", id: "subagent", cwd: "/workspace" })}\n`,
        ),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(sessionsDirectory, "other.jsonl"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Exact JSONL native session fixture.
          `${JSON.stringify({ type: "session", id: "other", cwd: "/other" })}\n`,
        ),
      );

      const sessions = yield* listPiFamilyNativeSessions(
        config(temporaryDirectory),
        ProviderInstanceId.make("omp"),
        "/workspace",
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        runtime: "omp",
        sessionId: "session-1",
        title: "Existing OMP work",
        model: "gpt-5.6",
        cwd: "/workspace",
        status: "complete",
      });
      const history = yield* readPiFamilyNativeHistoryMessages(
        config(temporaryDirectory),
        "session-1",
        "/workspace",
      );
      expect(history.map(({ text }) => text)).toEqual(["continue this", "done"]);

      const allSessions = yield* listPiFamilyNativeSessions(
        config(temporaryDirectory),
        ProviderInstanceId.make("omp"),
      );
      expect(allSessions.map((session) => session.sessionId).sort()).toEqual([
        "other",
        "session-1",
      ]);
    }),
  );

  it.effect("lists Pi sessions and projects renamed native metadata", () =>
    Effect.gen(function* () {
      const temporaryDirectory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-catalog-")),
      );
      temporaryDirectories.push(temporaryDirectory);
      const sessionsDirectory = NodePath.join(temporaryDirectory, "sessions", "project");
      yield* Effect.promise(() => NodeFSP.mkdir(sessionsDirectory, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(sessionsDirectory, "pi-session.jsonl"),
          [
            {
              type: "session",
              id: "pi-session-1",
              cwd: "/workspace",
              timestamp: "2026-08-01T12:00:00.000Z",
            },
            {
              type: "message",
              id: "user-1",
              timestamp: "2026-08-01T12:00:01.000Z",
              message: { role: "user", content: "Pi prompt" },
            },
            { type: "session_info", name: "Renamed Pi work" },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n") + "\n",
        ),
      );
      const nativeConfig = config(temporaryDirectory, "pi");
      const sessions = yield* listPiFamilyNativeSessions(
        nativeConfig,
        ProviderInstanceId.make("pi"),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        runtime: "pi",
        sessionId: "pi-session-1",
        title: "Renamed Pi work",
      });
      expect(
        yield* readPiFamilyNativeHistoryMessages(nativeConfig, "pi-session-1", "/workspace"),
      ).toEqual([
        {
          role: "user",
          text: "Pi prompt",
          timestamp: "2026-08-01T12:00:01.000Z",
        },
      ]);
    }),
  );

  it.effect("reads text history from the active branch of a flat session directory", () =>
    Effect.gen(function* () {
      const temporaryDirectory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-history-")),
      );
      temporaryDirectories.push(temporaryDirectory);
      const sessionPath = NodePath.join(temporaryDirectory, "session.jsonl");
      const lines = [
        {
          type: "session",
          version: 3,
          id: "session-history",
          cwd: "/workspace",
          timestamp: "2026-08-01T12:00:00.000Z",
        },
        {
          type: "model_change",
          id: "root",
          parentId: null,
          timestamp: "2026-08-01T12:00:00.000Z",
          model: "openai-codex/gpt-5.6",
        },
        {
          type: "message",
          id: "abandoned-user",
          parentId: "root",
          timestamp: "2026-08-01T12:00:01.000Z",
          message: { role: "user", content: "abandoned prompt" },
        },
        {
          type: "message",
          id: "abandoned-assistant",
          parentId: "abandoned-user",
          timestamp: "2026-08-01T12:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] },
        },
        {
          type: "message",
          id: "active-user",
          parentId: "root",
          timestamp: "2026-08-01T12:00:03.000Z",
          message: { role: "user", content: [{ type: "text", text: "active prompt" }] },
        },
        {
          type: "message",
          id: "active-assistant",
          parentId: "active-user",
          timestamp: "2026-08-01T12:00:04.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "active answer" }],
            model: "gpt-5.6",
          },
        },
        {
          type: "title_change",
          id: "leaf",
          parentId: "active-assistant",
          timestamp: "2026-08-01T12:00:05.000Z",
          title: "Active branch",
        },
      ];
      yield* Effect.promise(() =>
        NodeFSP.writeFile(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`),
      );
      const nativeConfig = {
        ...config("/unused"),
        launchArguments: ["--session-dir", temporaryDirectory],
      };

      const sessions = yield* listPiFamilyNativeSessions(
        nativeConfig,
        ProviderInstanceId.make("omp"),
        "/workspace",
      );
      expect(sessions).toHaveLength(1);
      const messages = yield* readPiFamilyNativeHistoryMessages(
        nativeConfig,
        "session-history",
        "/workspace",
      );
      expect(messages).toEqual([
        {
          role: "user",
          text: "active prompt",
          timestamp: "2026-08-01T12:00:03.000Z",
        },
        {
          role: "assistant",
          text: "active answer",
          timestamp: "2026-08-01T12:00:04.000Z",
          model: "gpt-5.6",
        },
      ]);
    }),
  );
});
