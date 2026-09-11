// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { makePiFamilyAdapter } from "./NativeAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveOmpBinaryPath(): string | undefined {
  if (process.env.SKIP_OMP_LIVE_TESTS === "1") {
    return undefined;
  }
  if (process.env.OMP_BINARY !== undefined) {
    const binaryPath = path.resolve(process.env.OMP_BINARY);
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch (err) {
      throw new Error(
        `Configured OMP_BINARY is missing or not executable (${binaryPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return binaryPath;
  }
  const candidateWorktreePath = path.resolve(
    __dirname,
    "../../../../../../omp-integration/packages/coding-agent/dist/omp",
  );
  if (fs.existsSync(candidateWorktreePath)) {
    return candidateWorktreePath;
  }
  const candidateRootPath = path.resolve(
    process.cwd(),
    "../omp-integration/packages/coding-agent/dist/omp",
  );
  if (fs.existsSync(candidateRootPath)) {
    return candidateRootPath;
  }
  return undefined;
}

const ompBinary = resolveOmpBinaryPath();

describe.skipIf(!ompBinary)("OMP live question round-trip with capability gating", () => {
  it.effect("exercises advertised capability path and verifies askDialog execution", () =>
    Effect.gen(function* () {
      assert.ok(ompBinary, "OMP binary must be resolved");
      const binaryPath = ompBinary;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-gated-"));
      const extFile = path.join(tempDir, "ext.mjs");
      fs.writeFileSync(
        extFile,
        `
export default function(pi) {
  pi.registerCommand("test_gated_ask", {
    description: "Exercise gated askDialog",
    handler: async (_args, ctx) => {
      if (ctx.ui.askDialog) {
        const res = await ctx.ui.askDialog([
          {
            id: "auth_choice",
            header: "Authentication",
            question: "Which auth provider?",
            options: [{ label: "JWT" }, { label: "OAuth2" }]
          }
        ]);
        ctx.ui.notify("ASK_RESULT:" + JSON.stringify(res), "info");
      } else {
        const res = await ctx.ui.select("Which auth provider?", [
          { label: "JWT" },
          { label: "OAuth2" }
        ]);
        ctx.ui.notify("FALLBACK_SELECT:" + res, "info");
      }
    }
  });
}
`,
      );

      const runtime = "omp" as const;
      const provider = ProviderDriverKind.make(runtime);
      const threadId = ThreadId.make("live-omp-gated-thread-1");
      const instanceId = ProviderInstanceId.make("live-omp-gated-instance-1");

      const adapter = yield* makePiFamilyAdapter({
        provider,
        runtime,
        binaryPath,
        cwd: tempDir,
        launchArguments: ["--mode", "rpc", "--extension", extFile],
        requestTimeoutMs: 15_000,
        startupTimeoutMs: 15_000,
        maxLineBytes: 1_048_576,
        maxMessageBytes: 67_108_864,
        stderrLimitBytes: 65_536,
        instanceId,
      });

      const eventQueue = yield* Queue.unbounded<any>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(eventQueue, event),
      ).pipe(Effect.forkScoped);

      try {
        yield* adapter.startSession({
          threadId,
          provider,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
        });

        // T3 default negotiation sends capabilities: { ui: { askDialog: true } }
        yield* adapter.sendTurn({ threadId, input: "/test_gated_ask" });

        // Wait for user-input.requested
        let userInputReq: any = null;
        while (!userInputReq) {
          const ev = yield* Queue.take(eventQueue);
          if (ev.type === "user-input.requested") {
            userInputReq = ev;
          }
        }

        assert.ok(userInputReq);
        assert.equal(userInputReq.type, "user-input.requested");
        const questions = userInputReq.payload.questions;
        assert.equal(questions.length, 1);
        assert.equal(questions[0]?.question, "Which auth provider?");
        assert.equal(questions[0]?.id, "auth_choice");

        const requestId = ApprovalRequestId.make(userInputReq.requestId);

        // Respond to user input with structured answer
        yield* adapter.respondToUserInput(threadId, requestId, {
          auth_choice: "JWT",
        });

        // Wait for user-input.resolved and notification showing ASK_RESULT
        let resolved = false;
        let notifyReceived = false;
        while (!resolved || !notifyReceived) {
          const ev = yield* Queue.take(eventQueue);
          if (ev.type === "user-input.resolved") {
            resolved = true;
          }
          const detailMessage =
            typeof ev.payload?.detail === "object" && ev.payload?.detail !== null
              ? (ev.payload.detail as any).message
              : ev.payload?.message;
          if (typeof detailMessage === "string" && detailMessage.includes("ASK_RESULT:")) {
            notifyReceived = true;
            assert.ok(detailMessage.includes('"selectedOptions":["JWT"]'));
          }
        }

        assert.equal(resolved, true);
        assert.equal(notifyReceived, true);

        yield* adapter.stopSession(threadId);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("falls back to select when host omits askDialog capability", async () => {
    assert.ok(ompBinary, "OMP binary must be resolved");
    const binaryPath = ompBinary;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ext-fallback-"));
    const extFile = path.join(tempDir, "ext.mjs");
    fs.writeFileSync(
      extFile,
      `
export default function(pi) {
  pi.registerCommand("test_gated_ask", {
    description: "Exercise gated askDialog",
    handler: async (_args, ctx) => {
      if (ctx.ui.askDialog) {
        const res = await ctx.ui.askDialog([
          {
            id: "auth_choice",
            header: "Authentication",
            question: "Which auth provider?",
            options: [{ label: "JWT" }, { label: "OAuth2" }]
          }
        ]);
        ctx.ui.notify("ASK_RESULT:" + JSON.stringify(res), "info");
      } else {
        const res = await ctx.ui.select("Which auth provider?", [
          { label: "JWT" },
          { label: "OAuth2" }
        ]);
        ctx.ui.notify("FALLBACK_SELECT:" + res, "info");
      }
    }
  });
}
`,
    );

    const child = cp.spawn(binaryPath, ["--mode", "rpc", "--extension", extFile], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = readline.createInterface({ input: child.stdout });

    let selectReceived = false;
    let fallbackNotifyReceived = false;

    const testPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new Error("Timed out waiting for fallback select/notify frames"));
      }, 10_000);

      const finish = (err?: unknown) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      rl.on("line", (line) => {
        try {
          const frame = JSON.parse(line);
          if (frame.type === "ready") {
            // Send negotiate_protocol WITHOUT capabilities
            child.stdin.write(
              JSON.stringify({
                id: "neg-1",
                type: "negotiate_protocol",
                protocolVersion: 2,
              }) + "\n",
            );
          } else if (frame.type === "response" && frame.command === "negotiate_protocol") {
            // Trigger command
            child.stdin.write(
              JSON.stringify({
                id: "turn-1",
                type: "prompt",
                message: "/test_gated_ask",
              }) + "\n",
            );
          } else if (frame.type === "extension_ui_request" && frame.method === "select") {
            selectReceived = true;
            assert.equal(frame.title, "Which auth provider?");
            assert.deepEqual(frame.options, ["JWT", "OAuth2"]);
            // Respond to select with "OAuth2"
            child.stdin.write(
              JSON.stringify({
                type: "extension_ui_response",
                id: frame.id,
                value: "OAuth2",
              }) + "\n",
            );
          } else if (
            frame.type === "extension_ui_request" &&
            frame.method === "notify" &&
            typeof frame.message === "string" &&
            frame.message.includes("FALLBACK_SELECT:")
          ) {
            fallbackNotifyReceived = true;
            assert.equal(frame.message, "FALLBACK_SELECT:OAuth2");
            finish();
          }
        } catch (err) {
          finish(err);
        }
      });
      child.on("error", finish);
      child.on("exit", (code) => {
        if (!fallbackNotifyReceived) {
          finish(new Error(`Child exited early with code ${code}`));
        }
      });
    });

    try {
      await testPromise;
      assert.equal(selectReceived, true);
      assert.equal(fallbackNotifyReceived, true);
    } finally {
      child.kill("SIGTERM");
      rl.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
