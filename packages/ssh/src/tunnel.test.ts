// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises real POSIX shells and HTTP processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { describeReadinessCause } from "@t3tools/shared/httpReadiness";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";
import {
  buildRemoteLaunchScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  remoteStateKey,
  REMOTE_PICK_PORT_SCRIPT,
} from "./remote-scripts.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RuntimeInfo {
  readonly version: 1;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
}

interface RecordValue {
  readonly [key: string]: unknown;
}

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRuntimeInfo(home: string): RuntimeInfo | undefined {
  try {
    const runtimePath = NodePath.join(home, ".t3", "userdata", "server-runtime.json");
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8"));
    if (
      !isRecordValue(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.origin !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    return {
      version: 1,
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      origin: parsed.origin,
      startedAt: parsed.startedAt,
    };
  } catch {
    return undefined;
  }
}

function parseLaunchResult(stdout: string): {
  readonly remotePort: number;
  readonly serverKind: "external" | "managed";
} {
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  if (line === undefined) {
    throw new Error("The remote launch script returned no output.");
  }
  const parsed: unknown = JSON.parse(line);
  if (
    !isRecordValue(parsed) ||
    typeof parsed.remotePort !== "number" ||
    !Number.isInteger(parsed.remotePort) ||
    parsed.remotePort <= 0 ||
    (parsed.serverKind !== "external" && parsed.serverKind !== "managed")
  ) {
    throw new Error(`Invalid remote launch output: ${line}`);
  }
  return {
    remotePort: parsed.remotePort,
    serverKind: parsed.serverKind,
  };
}

function runPosixScript(
  home: string,
  script: string,
  args: ReadonlyArray<string> = [],
): Promise<ShellResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ShellResult>();
  const child = NodeChildProcess.spawn("/bin/sh", ["-l", "-s", "--", ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  // A real shell integration test cannot use fake timers; bound a broken script's lifetime.
  const timeout = NodeTimers.setTimeout(() => {
    child.kill("SIGKILL");
  }, 10_000);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    NodeTimers.clearTimeout(timeout);
    reject(error);
  });
  child.once("close", (exitCode) => {
    NodeTimers.clearTimeout(timeout);
    resolve({ exitCode: exitCode ?? -1, stdout, stderr });
  });
  child.stdin?.end(script);
  return promise;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requestStatus(origin: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = NodeHttp.get(new URL(origin), (response) => {
    response.resume();
    response.once("end", () => resolve(response.statusCode ?? 0));
  });
  request.setTimeout(2_000, () => {
    request.destroy(new Error("HTTP readiness request timed out."));
  });
  request.once("error", reject);
  return promise;
}

function writeServerFixture(fixturePath: string): void {
  NodeFS.writeFileSync(
    fixturePath,
    `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const args = process.argv.slice(2);
const hostIndex = args.indexOf("--host");
const portIndex = args.indexOf("--port");
const baseDirIndex = args.indexOf("--base-dir");
if (
  args[0] !== "serve" ||
  hostIndex < 0 ||
  portIndex < 0 ||
  baseDirIndex < 0 ||
  args[hostIndex + 1] !== "127.0.0.1"
) {
  process.exit(2);
}
const host = args[hostIndex + 1];
const configuredPort = Number(args[portIndex + 1]);
const baseDir = args[baseDirIndex + 1];
if (!Number.isInteger(configuredPort) || configuredPort <= 0 || !baseDir) {
  process.exit(2);
}

const server = http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("ready");
});
const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.once("error", () => process.exit(1));
server.listen(configuredPort, host, () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    process.exit(1);
  }
  const runtime = {
    version: 1,
    pid: process.pid,
    host,
    port: address.port,
    origin: "http://127.0.0.1:" + address.port,
    startedAt: new Date().toISOString(),
  };
  const userdataPath = path.join(baseDir, "userdata");
  fs.mkdirSync(userdataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userdataPath, "server-runtime.json"),
    JSON.stringify(runtime) + "\\n",
  );
});
`,
    { encoding: "utf8", mode: 0o600 },
  );
}

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, "exec npx --yes 't3@latest' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@latest' -- \"$@\"");
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, "require_installed_t3_cli npx --yes --package 't3@latest'");
    assert.include(script, "require_installed_t3_cli npm exec --yes --package 't3@latest'");
    assert.include(script, "npm produced no t3 executable");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(script, "exec npx --yes 't3@nightly; touch /tmp/t3-owned' \"$@\"");
    assert.include(script, "exec npm exec --yes 't3@nightly; touch /tmp/t3-owned' -- \"$@\"");
    assert.include(
      script,
      "require_installed_t3_cli npx --yes --package 't3@nightly; touch /tmp/t3-owned'",
    );
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("reuses an owned server and preserves an adopted external server", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-launch-test-"));
    const fixturePath = NodePath.join(home, "server-fixture.cjs");
    const ownedTarget = {
      alias: "managed-target",
      hostname: "managed.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const externalTarget = {
      alias: "stale-target",
      hostname: "stale.example.com",
      username: "julius",
      port: 2223,
    } as const;
    const runner = {
      nodeScriptPath: fixturePath,
      allowPackageInstall: false,
    } as const;
    let ownedPid: number | undefined;

    try {
      writeServerFixture(fixturePath);
      const ownedKey = remoteStateKey(ownedTarget);
      const externalKey = remoteStateKey(externalTarget);
      const ownedStateDir = NodePath.join(home, ".t3", "ssh-launch", ownedKey);
      const externalStateDir = NodePath.join(home, ".t3", "ssh-launch", externalKey);

      const firstLaunch = await runPosixScript(home, buildRemoteLaunchScript(runner), [ownedKey]);
      if (firstLaunch.exitCode !== 0) {
        throw new Error(`Initial remote launch failed: ${firstLaunch.stderr}`);
      }
      const firstResult = parseLaunchResult(firstLaunch.stdout);
      assert.equal(firstResult.serverKind, "managed");

      const firstRuntime = readRuntimeInfo(home);
      if (firstRuntime === undefined) {
        throw new Error("The fixture did not write a valid server runtime state.");
      }
      ownedPid = firstRuntime.pid;
      assert.equal(firstResult.remotePort, firstRuntime.port);
      assert.equal(firstRuntime.host, "127.0.0.1");
      assert.equal(firstRuntime.origin, `http://127.0.0.1:${firstRuntime.port}`);
      assert.isTrue(isProcessAlive(firstRuntime.pid));
      assert.equal(await requestStatus(firstRuntime.origin), 200);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(ownedStateDir, "pid"), "utf8"),
        `${firstRuntime.pid}\n`,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(ownedStateDir, "managed"), "utf8"),
        "managed\n",
      );

      const secondLaunch = await runPosixScript(home, buildRemoteLaunchScript(runner), [ownedKey]);
      if (secondLaunch.exitCode !== 0) {
        throw new Error(`Repeated remote launch failed: ${secondLaunch.stderr}`);
      }
      const secondResult = parseLaunchResult(secondLaunch.stdout);
      assert.equal(secondResult.serverKind, "managed");
      assert.equal(secondResult.remotePort, firstRuntime.port);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(ownedStateDir, "managed"), "utf8"),
        "managed\n",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(ownedStateDir, "pid"), "utf8"),
        `${firstRuntime.pid}\n`,
      );
      const secondRuntime = readRuntimeInfo(home);
      if (secondRuntime === undefined) {
        throw new Error("The repeated launch removed the fixture runtime state.");
      }
      assert.equal(secondRuntime.pid, firstRuntime.pid);
      assert.equal(secondRuntime.port, firstRuntime.port);
      assert.isTrue(isProcessAlive(firstRuntime.pid));
      assert.equal(await requestStatus(firstRuntime.origin), 200);

      NodeFS.mkdirSync(externalStateDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(externalStateDir, "managed"), "managed\n", "utf8");
      assert.isFalse(NodeFS.existsSync(NodePath.join(externalStateDir, "pid")));

      const adoptedLaunch = await runPosixScript(home, buildRemoteLaunchScript(runner), [
        externalKey,
      ]);
      if (adoptedLaunch.exitCode !== 0) {
        throw new Error(`External adoption launch failed: ${adoptedLaunch.stderr}`);
      }
      const adoptedResult = parseLaunchResult(adoptedLaunch.stdout);
      assert.equal(adoptedResult.serverKind, "external");
      assert.equal(adoptedResult.remotePort, firstRuntime.port);
      assert.isTrue(isProcessAlive(firstRuntime.pid));
      assert.equal(await requestStatus(firstRuntime.origin), 200);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(externalStateDir, "managed"), "utf8"),
        "external\n",
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(externalStateDir, "pid")));

      const externalStop = await runPosixScript(home, buildRemoteStopScript(externalTarget));
      if (externalStop.exitCode !== 0) {
        throw new Error(`External stop failed: ${externalStop.stderr}`);
      }
      assert.isTrue(isProcessAlive(firstRuntime.pid));
      assert.equal(await requestStatus(firstRuntime.origin), 200);
    } finally {
      for (const target of [externalTarget, ownedTarget]) {
        try {
          await runPosixScript(home, buildRemoteStopScript(target));
        } catch {
          // Fall through to direct cleanup when a launch failed before its state files existed.
        }
      }
      const runtimePid = readRuntimeInfo(home)?.pid;
      for (const pid of new Set([ownedPid, runtimePid])) {
        if (pid === undefined || !isProcessAlive(pid)) {
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The process may have exited between the liveness check and kill.
        }
      }
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
