// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  listOmpNativeSessions,
  readOmpNativeHistoryMessages,
  resolveOmpSessionDirectory,
} from "./NativeSessionCatalog.ts";
import type { PiFamilyNativeConfig } from "./NativeAdapter.ts";

const temporaryDirectories: string[] = [];

function config(agentDirectory: string): PiFamilyNativeConfig {
  return {
    provider: ProviderDriverKind.make("omp"),
    runtime: "omp",
    binaryPath: "omp",
    cwd: "/workspace",
    agentDirectory,
    requestTimeoutMs: 1_000,
    startupTimeoutMs: 1_000,
    maxLineBytes: 1024,
    maxMessageBytes: 4096,
    stderrLimitBytes: 1024,
    instanceId: ProviderInstanceId.make("omp"),
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
  it("resolves explicit session directories before agent directories", () => {
    const nativeConfig = {
      ...config("/agent"),
      launchArguments: ["--session-dir", "/sessions"],
    };
    expect(resolveOmpSessionDirectory(nativeConfig)).toBe("/sessions");
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
        { type: "message", message: { role: "user", content: "continue this" } },
        {
          type: "message",
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
          '{"type":"session","id":"session-1","cwd":"/workspace","title":"Old duplicate"}\n',
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

      const sessions = yield* listOmpNativeSessions(
        config(temporaryDirectory),
        ProviderInstanceId.make("omp"),
        "/workspace",
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: "session-1",
        title: "Existing OMP work",
        model: "gpt-5.6",
        cwd: "/workspace",
        status: "complete",
      });

      const allSessions = yield* listOmpNativeSessions(
        config(temporaryDirectory),
        ProviderInstanceId.make("omp"),
      );
      expect(allSessions.map((session) => session.sessionId).sort()).toEqual([
        "other",
        "session-1",
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

      const sessions = yield* listOmpNativeSessions(
        nativeConfig,
        ProviderInstanceId.make("omp"),
        "/workspace",
      );
      expect(sessions).toHaveLength(1);
      const messages = yield* readOmpNativeHistoryMessages(
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
