// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  listPiFamilyNativeSessions,
  readPiFamilyNativeHistoryMessages,
  readPiFamilyNativeSubagentTranscript,
  resolvePiFamilySessionDirectory,
  type PiFamilySessionCatalogConfig,
} from "./NativeSessionCatalog.ts";

const temporaryDirectories: string[] = [];

function config(
  agentDirectory?: string,
  runtime: PiFamilySessionCatalogConfig["runtime"] = "omp",
): PiFamilySessionCatalogConfig {
  if (agentDirectory === undefined) {
    return { runtime, cwd: "/workspace" };
  }
  return { runtime, cwd: "/workspace", agentDirectory };
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

    expect(
      resolvePiFamilySessionDirectory({
        ...config(),
        environment: { HOME: "/configured-home" },
      }),
    ).toBe("/configured-home/.omp/agent/sessions");
    expect(
      resolvePiFamilySessionDirectory({
        ...config(),
        launchArguments: ["--profile", "work"],
        environment: { HOME: "/configured-home" },
      }),
    ).toBe("/configured-home/.omp/profiles/work/agent/sessions");
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
      expect(history).toMatchObject([
        {
          role: "user",
          text: "continue this",
          timestamp: "2026-08-01T12:00:01.000Z",
        },
        {
          role: "assistant",
          text: "done",
          timestamp: "2026-08-01T12:00:02.000Z",
          model: "gpt-5.6",
        },
      ]);

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
      ).toMatchObject([
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
            content: [
              { type: "thinking", thinking: "consider\nthis" },
              { type: "text", text: "active answer\nwith formatting" },
              {
                type: "toolCall",
                id: "call-1",
                name: "read",
                arguments: { path: "src/a.ts" },
              },
              {
                type: "toolCall",
                id: "call-2",
                name: "bash",
                arguments: { command: "printf x" },
              },
            ],
            model: "gpt-5.6",
          },
        },
        {
          type: "message",
          id: "active-tool-result-1",
          parentId: "active-assistant",
          timestamp: "2026-08-01T12:00:05.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "file\ncontents" }],
          },
        },
        {
          type: "message",
          id: "active-tool-result-2",
          parentId: "active-tool-result-1",
          timestamp: "2026-08-01T12:00:06.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-2",
            toolName: "bash",
            content: [{ type: "text", text: "failed output" }],
            isError: true,
          },
        },
        {
          type: "title_change",
          id: "leaf",
          parentId: "active-tool-result-2",
          timestamp: "2026-08-01T12:00:07.000Z",
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
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "assistant",
        "tool",
        "tool",
        "tool",
        "tool",
      ]);
      expect(messages[0]).toMatchObject({
        text: "active prompt",
        timestamp: "2026-08-01T12:00:03.000Z",
      });
      expect(messages[1]).toMatchObject({
        text: "consider\nthis",
        timestamp: "2026-08-01T12:00:04.000Z",
      });
      expect(messages[2]).toMatchObject({
        text: "active answer\nwith formatting",
        model: "gpt-5.6",
      });
      expect(messages.slice(3)).toMatchObject([
        {
          role: "tool",
          toolCallId: "call-1",
          phase: "started",
          sourceId: "active-assistant",
          sourceIndex: 2,
          payload: {
            title: "Read File",
            data: {
              toolCallId: "call-1",
              item: { name: "read", input: { path: "src/a.ts" } },
            },
          },
        },
        {
          role: "tool",
          toolCallId: "call-2",
          phase: "started",
          sourceIndex: 3,
        },
        {
          role: "tool",
          toolCallId: "call-1",
          phase: "completed",
          sourceId: "active-tool-result-1",
          payload: {
            status: "completed",
            data: {
              toolCallId: "call-1",
              item: {
                input: { path: "src/a.ts" },
                result: { content: [{ type: "text", text: "file\ncontents" }] },
              },
            },
          },
        },
        {
          role: "tool",
          toolCallId: "call-2",
          phase: "completed",
          payload: {
            status: "failed",
            data: {
              toolCallId: "call-2",
              item: {
                result: { content: [{ type: "text", text: "failed output" }], isError: true },
              },
            },
          },
        },
      ]);
    }),
  );

  it.effect(
    "recovers persisted child task state without treating the task-tool result as success",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-task-catalog-")),
        );
        temporaryDirectories.push(root);
        const parentPath = NodePath.join(root, "parent.jsonl");
        const childDirectory = NodePath.join(root, "parent");
        const childPath = NodePath.join(childDirectory, "ProofA.jsonl");
        const longPrompt = "historical child input ".repeat(4_000);
        const parentLines = [
          {
            type: "session",
            id: "parent",
            cwd: "/workspace",
            timestamp: "2026-08-01T12:00:00.000Z",
          },
          {
            type: "message",
            id: "assistant",
            parentId: "parent",
            timestamp: "2026-08-01T12:00:01.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "task-call",
                  name: "task",
                  arguments: { tasks: [{ name: "ProofA", task: "Return proof" }] },
                },
              ],
            },
          },
          {
            type: "message",
            id: "result",
            parentId: "assistant",
            timestamp: "2026-08-01T12:00:02.000Z",
            message: {
              role: "toolResult",
              toolCallId: "task-call",
              toolName: "task",
              details: {
                progress: [
                  {
                    id: "ProofA",
                    agent: "scout",
                    assignment: "Return proof",
                    status: "pending",
                  },
                ],
              },
            },
          },
        ];
        const childLines = [
          { type: "session", id: "child-session", cwd: "/workspace" },
          {
            type: "message",
            id: "child-user",
            parentId: "child-session",
            timestamp: "2026-08-01T12:00:03.000Z",
            message: { role: "user", content: longPrompt },
          },
          {
            type: "message",
            id: "child-tool-call",
            parentId: "child-user",
            timestamp: "2026-08-01T12:00:04.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "read-call",
                  name: "read",
                  arguments: { path: "proof.txt" },
                },
              ],
            },
          },
          {
            type: "message",
            id: "child-tool-result",
            parentId: "child-tool-call",
            timestamp: "2026-08-01T12:00:05.000Z",
            message: {
              role: "toolResult",
              toolCallId: "read-call",
              toolName: "read",
              content: [{ type: "text", text: "proof output" }],
            },
          },
          {
            type: "message",
            id: "child-assistant",
            parentId: "child-tool-result",
            timestamp: "2026-08-01T12:00:06.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial proof" }],
              stopReason: "aborted",
              errorMessage: "Request was aborted",
            },
          },
        ];
        yield* Effect.promise(() =>
          NodeFSP.mkdir(childDirectory, { recursive: true }).then(() =>
            Promise.all([
              NodeFSP.writeFile(
                parentPath,
                `${parentLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
              ),
              NodeFSP.writeFile(
                childPath,
                `${childLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
              ),
            ]),
          ),
        );
        const messages = yield* readPiFamilyNativeHistoryMessages(
          { ...config(root), launchArguments: ["--session-dir", root] },
          "parent",
          "/workspace",
        );
        const taskMessage = messages.find(
          (message) => message.role === "tool" && message.phase === "completed",
        );
        expect(taskMessage).toMatchObject({
          toolCallId: "task-call",
          tasks: [
            {
              taskId: "ProofA",
              status: "interrupted",
              summary: "partial proof",
              error: "Request was aborted",
            },
          ],
        });
        const nativeConfig = { ...config(root), launchArguments: ["--session-dir", root] };
        const transcript = yield* readPiFamilyNativeSubagentTranscript(
          nativeConfig,
          "parent",
          "ProofA",
          "/workspace",
        );
        expect(transcript.entries.map((entry) => entry.kind)).toEqual([
          "user",
          "tool",
          "tool",
          "assistant",
        ]);
        expect(transcript.entries[0]?.text).toBe(longPrompt);
        expect(transcript.entries[1]).toMatchObject({
          toolName: "read",
          text: 'Called read\n{\n  "path": "proof.txt"\n}',
        });
        expect(transcript.entries[2]).toMatchObject({
          kind: "tool",
          toolName: "read",
          text: "proof output",
        });
        expect(transcript.entries[3]).toMatchObject({ text: "partial proof" });
        expect(
          yield* readPiFamilyNativeSubagentTranscript(
            nativeConfig,
            "parent",
            "ProofA",
            "/workspace",
            transcript.nextCursor,
          ),
        ).toMatchObject({ entries: [], reset: false, nextCursor: transcript.nextCursor });

        const missing = yield* Effect.exit(
          readPiFamilyNativeSubagentTranscript(nativeConfig, "parent", "Missing", "/workspace"),
        );
        expect(Exit.isFailure(missing)).toBe(true);
        if (Exit.isFailure(missing)) {
          expect(Cause.squash(missing.cause)).toMatchObject({ code: "not_found" });
        }
        const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
        const appendYield = (type: string | string[]) =>
          encodeMessage({
            type: "message",
            timestamp: "2026-08-01T12:00:09.000Z",
            message: {
              role: "toolResult",
              toolName: "yield",
              isError: false,
              details: { status: "success", type, data: { proof: "accepted" } },
            },
          }).pipe(
            Effect.flatMap((encoded) =>
              Effect.promise(() => NodeFSP.appendFile(childPath, `${encoded}\n`)),
            ),
          );
        yield* appendYield(["progress"]);
        const incremental = yield* readPiFamilyNativeHistoryMessages(
          nativeConfig,
          "parent",
          "/workspace",
        );
        const incrementalMessage = incremental.find(
          (message) => message.role === "tool" && message.phase === "completed",
        );
        expect(
          incrementalMessage?.role === "tool" ? incrementalMessage.tasks?.[0]?.status : undefined,
        ).toBe("interrupted");
        yield* appendYield("final");
        const final = yield* readPiFamilyNativeHistoryMessages(
          nativeConfig,
          "parent",
          "/workspace",
        );
        const completedMessage = final.find(
          (message) => message.role === "tool" && message.phase === "completed",
        );
        const completedTask =
          completedMessage?.role === "tool" ? completedMessage.tasks?.[0] : undefined;
        expect(completedTask?.status).toBe("completed");
        expect(completedTask?.error).toBeUndefined();
        expect(Date.parse(completedTask?.endedAt ?? "")).toBeGreaterThan(
          Date.parse(completedMessage?.timestamp ?? ""),
        );
      }),
  );

  it.effect("resolves archived OMP image blobs without escaping the agent blob store", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-image-blobs-")),
      );
      temporaryDirectories.push(root);
      const agentDirectory = NodePath.join(root, "agent");
      const sessionDirectory = NodePath.join(root, "external-sessions");
      const blobDirectory = NodePath.join(agentDirectory, "blobs");
      const imageData =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iRFUAAAAASUVORK5CYII=";
      const bytes = Buffer.from(imageData, "base64");
      const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const image = { type: "image", mimeType: "image/png", data: `blob:sha256:${hash}` };
      const invalidImage = { ...image, data: "blob:sha256:../private.txt" };
      const records = [
        {
          type: "session",
          id: "blob-session",
          cwd: "/workspace",
          timestamp: "2026-08-01T12:00:00.000Z",
        },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp: "2026-08-01T12:00:01.000Z",
          message: { role: "user", content: [image] },
        },
        {
          type: "message",
          id: "assistant",
          parentId: "user",
          timestamp: "2026-08-01T12:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "image-call",
                name: "read",
                arguments: { path: "image.png" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "result",
          parentId: "assistant",
          timestamp: "2026-08-01T12:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "image-call",
            toolName: "read",
            content: [image, invalidImage],
          },
        },
      ];
      const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const lines = yield* Effect.forEach(records, (record) => encodeRecord(record));
      const source = `${lines.join("\n")}\n`;
      const sessionFile = NodePath.join(sessionDirectory, "session.jsonl");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(blobDirectory, { recursive: true });
        await NodeFSP.mkdir(sessionDirectory);
        await Promise.all([
          NodeFSP.writeFile(NodePath.join(blobDirectory, hash), bytes),
          NodeFSP.writeFile(NodePath.join(agentDirectory, "private.txt"), "PRIVATE_DATA"),
          NodeFSP.writeFile(sessionFile, source),
        ]);
      });
      const history = yield* readPiFamilyNativeHistoryMessages(
        { ...config(agentDirectory), launchArguments: ["--session-dir", sessionDirectory] },
        "blob-session",
        "/workspace",
      );
      expect(history[0]).toMatchObject({ role: "user", images: [{ ...image, data: imageData }] });
      expect(
        history.find((message) => message.role === "tool" && message.phase === "completed"),
      ).toMatchObject({
        payload: {
          data: { item: { result: { content: [{ ...image, data: imageData }, invalidImage] } } },
        },
      });
      expect(yield* Effect.promise(() => NodeFSP.readFile(sessionFile, "utf8"))).toBe(source);
    }),
  );

  it.effect("reads native history through another path to the same workspace", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-workspace-alias-")),
      );
      temporaryDirectories.push(root);
      const workspace = NodePath.join(root, "workspace");
      const alias = NodePath.join(root, "alias");
      yield* Effect.promise(() => NodeFSP.mkdir(workspace));
      yield* Effect.promise(() => NodeFSP.symlink(workspace, alias, "dir"));
      const canonicalWorkspace = yield* Effect.promise(() => NodeFSP.realpath(workspace));
      const nativeConfig = { ...config(root, "pi"), launchArguments: ["--session-dir", root] };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(root, "session.jsonl"),
          [
            {
              type: "session",
              version: 3,
              id: "alias-session",
              cwd: canonicalWorkspace,
              timestamp: "2026-08-01T12:00:00.000Z",
            },
            {
              type: "message",
              id: "user",
              parentId: null,
              timestamp: "2026-08-01T12:00:01.000Z",
              message: { role: "user", content: "Same workspace" },
            },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
        ),
      );
      const sessions = yield* listPiFamilyNativeSessions(
        nativeConfig,
        ProviderInstanceId.make("pi"),
        alias,
      );
      expect(sessions.map((session) => session.sessionId)).toEqual(["alias-session"]);
      const history = yield* readPiFamilyNativeHistoryMessages(
        nativeConfig,
        "alias-session",
        alias,
      );
      expect(history).toMatchObject([{ role: "user", text: "Same workspace" }]);
    }),
  );
});
