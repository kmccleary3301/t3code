import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  discoverPiFamilyModels,
  mapPiFamilyModels,
  resolvePiFamilyLaunchArguments,
  type PiFamilyModelDiscoveryConfig,
} from "./ModelDiscovery.ts";

function jsonl(...frames: ReadonlyArray<Record<string, unknown>>): Stream.Stream<Uint8Array> {
  return Stream.make(
    new TextEncoder().encode(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`),
  );
}

function chunked(frame: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const bytes = new TextEncoder().encode(JSON.stringify(frame));
  const split = Math.ceil(bytes.byteLength / 2);
  const encode = (part: Uint8Array) => {
    let binary = "";
    for (const byte of part) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  return [0, 1].map((index) => {
    const payload = bytes.subarray(index === 0 ? 0 : split, index === 0 ? split : undefined);
    return {
      type: "rpc_chunk",
      chunkId: "models",
      index,
      count: 2,
      byteLength: bytes.byteLength,
      data: encode(payload),
    };
  });
}

function makeConfig(runtime: "pi" | "omp"): PiFamilyModelDiscoveryConfig {
  return {
    runtime,
    provider: runtime,
    binaryPath: "/fake/native",
    cwd: "/tmp",
    environment: { FROM_INSTANCE: "yes" },
    agentDirectory: "/tmp/agent",
    launchArguments: ["--mode", "rpc"],
    trustMode: "approve-for-this-run",
    requestTimeoutMs: 1_000,
    startupTimeoutMs: 1_000,
    maxLineBytes: 1_048_576,
    maxMessageBytes: 67_108_864,
  };
}

function makeSpawner(
  stdout: Stream.Stream<Uint8Array>,
  commands: Array<unknown>,
  killed: { value: number },
) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      commands.push(command);
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () =>
          Effect.sync(() => {
            killed.value += 1;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
      return handle;
    }),
  );
}

describe("Pi-family model discovery mapping", () => {
  it("maps provider-prefixed slugs and native defaults", () => {
    expect(
      mapPiFamilyModels({
        rows: [
          { provider: "openai", id: "gpt-test", name: "GPT Test" },
          { provider: "anthropic", id: "claude-test" },
          { provider: "", id: "ignored" },
          { provider: "openai" },
          { provider: 42, id: "ignored" },
        ],
        currentModel: { provider: "anthropic", id: "claude-test" },
      }),
    ).toEqual([
      { slug: "openai/gpt-test", name: "GPT Test", isCustom: false, capabilities: null },
      {
        slug: "anthropic/claude-test",
        name: "claude-test",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ]);
  });

  it("rejects malformed model lists while ignoring malformed rows", () => {
    expect(() => mapPiFamilyModels({ rows: { models: [] } })).toThrow("malformed model list");
    expect(mapPiFamilyModels({ rows: [{ provider: "p", id: "m" }, null] })).toHaveLength(1);
  });
});

describe("Pi-family model discovery RPC", () => {
  it.effect("uses Pi unchunked RPC and closes its child", () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      const killed = { value: 0 };
      const result = yield* discoverPiFamilyModels(makeConfig("pi")).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(
            jsonl(
              {
                id: "get_state-1",
                type: "response",
                command: "get_state",
                success: true,
                data: { model: { provider: "p", id: "m" } },
              },
              {
                id: "get_available_models-2",
                type: "response",
                command: "get_available_models",
                success: true,
                data: { models: [{ provider: "p", id: "m", name: "Model" }] },
              },
            ),
            commands,
            killed,
          ),
        ),
      );
      expect(result.models[0]?.slug).toBe("p/m");
      expect(result.models[0]?.isDefault).toBe(true);
      expect(killed.value).toBeGreaterThan(0);
      const command = commands[0] as { readonly args: ReadonlyArray<string> };
      expect(command.args.filter((arg) => arg === "--mode")).toHaveLength(1);
    }),
  );

  it.effect("negotiates OMP and reassembles a chunked model response", () =>
    Effect.gen(function* () {
      const commands: unknown[] = [];
      const killed = { value: 0 };
      const ready = {
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864,
      };
      const frames = [
        ready,
        {
          id: "protocol-1",
          type: "response",
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        },
        {
          id: "get_state-1",
          type: "response",
          command: "get_state",
          success: true,
          data: { model: { provider: "p", id: "m" } },
        },
        ...chunked({
          id: "get_available_models-2",
          type: "response",
          command: "get_available_models",
          success: true,
          data: { models: [{ provider: "p", id: "m", name: "Chunked" }] },
        }),
      ];
      const result = yield* discoverPiFamilyModels(makeConfig("omp")).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(
            Stream.make(
              new TextEncoder().encode(
                `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
              ),
            ),
            commands,
            killed,
          ),
        ),
      );
      expect(result.models.map((model) => model.slug)).toEqual(["p/m"]);
      expect(killed.value).toBeGreaterThan(0);
    }),
  );

  it.effect("fails on malformed envelopes and still closes the child", () =>
    Effect.gen(function* () {
      const killed = { value: 0 };
      const error = yield* discoverPiFamilyModels(makeConfig("pi")).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(
            jsonl({ id: "get_state-1", type: "response", command: "get_state" }),
            [],
            killed,
          ),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(Error);
      expect(killed.value).toBeGreaterThan(0);
    }),
  );
});

it("does not duplicate native mode arguments", () => {
  expect(resolvePiFamilyLaunchArguments(["--mode", "rpc"], "approve-for-this-run")).toEqual([
    "--mode",
    "rpc",
    "--approve",
  ]);
});
