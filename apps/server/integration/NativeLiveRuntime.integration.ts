// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { NativeTraceSinkFactory } from "../src/provider/piFamily/NativeTrace.ts";
import type { PiFamilyRuntimeKind } from "../src/provider/piFamily/protocol.ts";

export type NativeLiveRuntime = PiFamilyRuntimeKind;

export interface NativeLiveConfig {
  readonly runtime: NativeLiveRuntime;
  readonly provider: ProviderDriverKind;
  readonly binaryPath: string;
  readonly launchArguments: ReadonlyArray<string>;
  readonly trustMode?: string;
}

export interface NativeLiveModelServer {
  readonly baseUrl: string;
  readonly requestCount: () => number;
  readonly imageRequestCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * A bounded no-retention sink still exercises the adapter's child-exit lifecycle
 * without placing native prompts or model output in test artifacts.
 */
export const nativeLiveTraceSinkFactory: NativeTraceSinkFactory = {
  create: () => ({
    recordBytes: () => {},
    recordExit: () => {},
    invalidate: () => {},
    finalize: () => {},
  }),
};

export const nativeLiveConfiguration = (
  runtime: NativeLiveRuntime,
): NativeLiveConfig | undefined => {
  const binaryPath = process.env[`T3_NATIVE_${runtime.toUpperCase()}_BINARY`]?.trim();
  if (!binaryPath) return undefined;
  return {
    runtime,
    provider: ProviderDriverKind.make(runtime),
    binaryPath,
    launchArguments:
      runtime === "pi"
        ? [
            "--mode",
            "rpc",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--offline",
            "--provider",
            "local",
            "--model",
            "local/test",
          ]
        : [
            "--mode",
            "rpc",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-rules",
            "--no-title",
            "--provider",
            "local",
            "--model",
            "local/test",
          ],
    ...(runtime === "pi" ? { trustMode: "approve-for-this-run" } : {}),
  };
};

export const configuredNativeLiveConfigurations = (): ReadonlyArray<NativeLiveConfig> => {
  const runtimeFilter = process.env.T3_NATIVE_LIVE_RUNTIME?.trim();
  return (["pi", "omp"] as const)
    .map(nativeLiveConfiguration)
    .filter(
      (config): config is NativeLiveConfig =>
        config !== undefined && (runtimeFilter === undefined || config.runtime === runtimeFilter),
    );
};

export const makeNativeLiveModelServer = Effect.tryPromise<NativeLiveModelServer>(() => {
  const { promise, resolve, reject } = Promise.withResolvers<NativeLiveModelServer>();
  let requestCount = 0;
  let imageRequestCount = 0;
  let retryFailureCount = 0;
  const pendingTimers = new Set<NodeJS.Timeout>();
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("error", () => response.destroy());
    request.on("end", () => {
      let message = "";
      let bodyText = "";
      try {
        bodyText = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(bodyText) as {
          readonly messages?: ReadonlyArray<{
            readonly content?: unknown;
          }>;
        };
        const content = body.messages?.at(-1)?.content;
        message = typeof content === "string" ? content : JSON.stringify(content ?? "");
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (
        bodyText.includes('"image_url"') ||
        bodyText.includes('"type":"image"') ||
        bodyText.includes('"type": "image"')
      ) {
        imageRequestCount += 1;
      }
      const requestNumber = requestCount + 1;
      if (bodyText.includes("NATIVE-MATRIX-RETRY") && retryFailureCount === 0) {
        retryFailureCount += 1;
        requestCount = requestNumber;
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        response.end(
          JSON.stringify({
            error: {
              message: "Native matrix transient failure.",
              type: "rate_limit_error",
            },
          }),
        );
        return;
      }
      const delayMs = bodyText.includes("NATIVE-MATRIX-HOLD")
        ? 30_000
        : bodyText.includes("NATIVE-MATRIX-WRITE")
          ? 500
          : 0;
      let timer: NodeJS.Timeout | undefined;
      const send = () => {
        requestCount = requestNumber;
        if (timer !== undefined) {
          pendingTimers.delete(timer);
          timer = undefined;
        }
        const marker = message.includes("RESTORED")
          ? "NATIVE-MATRIX-RESTORED-OK"
          : "NATIVE-MATRIX-OK";
        const frames = [
          {
            id: `native-matrix-${requestNumber}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "test",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: marker },
                finish_reason: null,
              },
            ],
          },
          {
            id: `native-matrix-${requestNumber}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        if (!response.headersSent) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
        }
        response.end(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        );
      };
      if (delayMs > 0) {
        if (!response.headersSent) {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.flushHeaders();
        }
        requestCount = requestNumber;
        response.write(": native-matrix-hold\n\n");
        // @effect-diagnostics-next-line globalTimers:off - Native HTTP test server delay.
        timer = setTimeout(send, delayMs);
        pendingTimers.add(timer);
        request.once("close", () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            pendingTimers.delete(timer);
            timer = undefined;
          }
        });
      } else {
        send();
      }
    });
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Native live model server did not expose a TCP address."));
      return;
    }
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requestCount: () => requestCount,
      imageRequestCount: () => imageRequestCount,
      close: () => {
        const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();
        server.closeAllConnections();
        server.closeIdleConnections();
        server.close(() => resolveClose());
        return closePromise;
      },
    });
  });
  return promise;
});

class NativeLiveRuntimeError extends Schema.TaggedErrorClass<NativeLiveRuntimeError>()(
  "NativeLiveRuntimeError",
  { cause: Schema.Defect() },
) {}
const nativeLiveError = (cause: unknown): NativeLiveRuntimeError =>
  new NativeLiveRuntimeError({ cause });
export const makeNativeLiveAgentDirectory = (
  prefix = "/tmp/t3-native-live-",
): Effect.Effect<string, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const directory = await NodeFS.promises.mkdtemp(prefix);
      await NodeFS.promises.chmod(directory, 0o700);
      return directory;
    },
    catch: nativeLiveError,
  });

/**
 * Launches the configured stock runtime as a child and terminates only that
 * owned child when the crash marker crosses stdin. This keeps the production
 * adapter unmodified while exercising its real child-exit path.
 */
export const writeNativeCrashWrapper = (
  agentDirectory: string,
): Effect.Effect<string, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const wrapperPath = NodePath.join(agentDirectory, "native-crash-wrapper.cjs");
      await NodeFS.promises.writeFile(
        wrapperPath,
        [
          'const { spawn } = require("node:child_process");',
          'const readline = require("node:readline");',
          "const [binaryPath, ...binaryArguments] = process.argv.slice(2);",
          "const child = spawn(binaryPath, binaryArguments, { stdio: ['pipe', 'pipe', 'pipe'] });",
          "child.stdout.pipe(process.stdout);",
          "child.stderr.pipe(process.stderr);",
          "let crashing = false;",
          "const input = readline.createInterface({ input: process.stdin });",
          "input.on('line', (line) => {",
          "  child.stdin.write(line + '\\n');",
          "  if (!crashing && line.includes('NATIVE-MATRIX-CRASH')) {",
          "    crashing = true;",
          "    setTimeout(() => child.kill('SIGKILL'), 750);",
          "  }",
          "});",
          "input.on('close', () => child.stdin.end());",
          "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {",
          "  process.on(signal, () => child.kill(signal));",
          "}",
          "child.once('error', () => process.exit(127));",
          "child.once('exit', (code, signal) => {",
          "  process.exit(code ?? (signal ? 137 : 1));",
          "});",
          "process.once('exit', () => {",
          "  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');",
          "});",
        ].join("\n") + "\n",
        { mode: 0o700 },
      );
      return wrapperPath;
    },
    catch: nativeLiveError,
  });

export const writeNativeLiveConfig = (
  config: NativeLiveConfig,
  agentDirectory: string,
  modelServer: NativeLiveModelServer,
): Effect.Effect<void, NativeLiveRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      if (config.runtime === "pi") {
        await NodeFS.promises.writeFile(
          NodePath.join(agentDirectory, "models.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Pi model test config is JSON.
          JSON.stringify({
            providers: {
              local: {
                baseUrl: modelServer.baseUrl,
                api: "openai-completions",
                apiKey: "native-matrix",
                models: ["test", "alternate"].map((id) => ({
                  id,
                  name: `Native Matrix ${id}`,
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 128_000,
                  maxTokens: 1024,
                })),
              },
            },
          }),
          { mode: 0o600 },
        );
        await NodeFS.promises.writeFile(
          NodePath.join(agentDirectory, "settings.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Pi settings test config is JSON.
          JSON.stringify({
            defaultProvider: "local",
            defaultModel: "test",
            defaultThinkingLevel: "off",
          }),
          { mode: 0o600 },
        );
        return;
      }
      await NodeFS.promises.writeFile(
        NodePath.join(agentDirectory, "models.yml"),
        [
          "providers:",
          "  local:",
          `    baseUrl: ${modelServer.baseUrl}`,
          "    api: openai-completions",
          "    auth: none",
          "    models:",
          "      - id: test",
          "        name: Native Matrix Test",
          "        reasoning: true",
          "        thinking: { mode: effort, efforts: [low, medium, high] }",
          "        input: [text, image]",
          "        contextWindow: 128000",
          "        maxTokens: 1024",
          "      - id: alternate",
          "        name: Native Matrix Alternate",
          "        reasoning: true",
          "        thinking: { mode: effort, efforts: [low, medium, high] }",
          "        input: [text, image]",
          "        contextWindow: 128000",
          "        maxTokens: 1024",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
    },
    catch: nativeLiveError,
  });
