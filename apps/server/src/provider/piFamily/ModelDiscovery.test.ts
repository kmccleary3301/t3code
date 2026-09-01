import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  discoverPiFamilyModels,
  mapPiFamilyModels,
  modelDiscoverySnapshotMessage,
  PiFamilyModelDiscoveryError,
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
function realProbeScript(
  mode:
    | "pi"
    | "omp"
    | "omp-missing-capabilities"
    | "omp-malformed-capabilities"
    | "omp-empty-capabilities"
    | "omp-malformed-id"
    | "omp-bad-ready"
    | "pi-empty",
) {
  const runtime = mode.startsWith("omp") ? "omp" : "pi";
  return (
    [
      "#!/usr/bin/env node",
      'import { createInterface } from "node:readline";',
      'const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");',
      `const runtime = ${JSON.stringify(runtime)};`,
      `const mode = ${JSON.stringify(mode)};`,
      'if (runtime === "omp") send({ type: "ready", protocolVersion: mode === "omp-bad-ready" ? 0 : 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });',
      'if (mode === "omp-bad-ready") setTimeout(() => process.exit(1), 100);',
      "const input = createInterface({ input: process.stdin });",
      'input.on("line", (line) => {',
      "  const request = JSON.parse(line);",
      "  let data;",
      '  if (request.type === "get_capabilities") data = mode === "omp-missing-capabilities" ? undefined : mode === "omp-malformed-capabilities" ? [] : mode === "omp-empty-capabilities" ? {} : { models: { discover: true } };',
      '  else if (request.type === "get_state") data = { model: { provider: "probe", id: "model" } };',
      '  else if (request.type === "get_available_models") data = { models: mode === "pi-empty" ? [] : [{ provider: "probe", id: "model", name: "Probe Model" }] };',
      '  else if (request.type === "get_commands") data = { commands: [{ name: "review", description: "Review changes", source: "extension", sourceInfo: {} }, { name: "skill:ship", description: "Ship the change", source: "skill", sourceInfo: {} }] };',
      '  else if (request.type === "get_available_commands") data = { commands: [{ name: "agents", aliases: ["agent"], description: "Manage agents", input: { hint: "<command>" }, source: "builtin" }, { name: "goal", description: "Manage goal mode", input: { hint: "[objective]" }, subcommands: [{ name: "set", description: "Set the goal", usage: "<objective>" }, { name: "budget", description: "Adjust token budget", usage: "<N|off>" }], source: "builtin" }, { name: "todo", description: "Manage todos", source: "builtin" }] };',
      '  else if (request.type === "negotiate_protocol") data = { protocolVersion: 2 };',
      "  else return;",
      '  const response = { type: "response", command: request.type, success: mode === "omp-missing-capabilities" && request.type === "get_capabilities" ? false : true, ...(data === undefined ? {} : { data }) };',
      '  send(mode === "omp-missing-capabilities" && request.type === "get_capabilities" ? response : { id: mode === "omp-malformed-id" && request.type === "get_capabilities" ? 42 : request.id, ...response });',
      '  if (request.type === "get_commands" || request.type === "get_available_commands") setTimeout(() => process.exit(0), 50);',
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n") + "\n"
  );
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
        runtime: "pi",
        rows: [
          { provider: "openai", id: "gpt-test", name: "GPT Test", reasoning: false },
          {
            provider: "anthropic",
            id: "claude-test",
            reasoning: true,
            thinkingLevelMap: { xhigh: "enabled", max: null },
          },
          { provider: "", id: "ignored" },
          { provider: "openai" },
          { provider: 42, id: "ignored" },
        ],
        currentModel: { provider: "anthropic", id: "claude-test" },
        currentThinkingLevel: "high",
      }),
    ).toEqual([
      { slug: "openai/gpt-test", name: "GPT Test", isCustom: false, capabilities: null },
      {
        slug: "anthropic/claude-test",
        name: "claude-test",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinkingLevel",
              label: "Thinking",
              type: "select",
              options: [
                { id: "off", label: "Off" },
                { id: "minimal", label: "Minimal" },
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
              ],
              currentValue: "high",
            },
          ],
        },
      },
    ]);
  });

  it("maps OMP's advertised thinking efforts without Pi fallbacks", () => {
    expect(
      mapPiFamilyModels({
        runtime: "omp",
        rows: [
          {
            provider: "openai",
            id: "reasoning-model",
            name: "Reasoning Model",
            reasoning: true,
            thinking: {
              mode: "effort",
              efforts: ["low", "high", "xhigh", "max"],
              defaultLevel: "high",
              requiresEffort: true,
            },
          },
          { provider: "openai", id: "fixed-reasoning", reasoning: true },
        ],
        currentModel: { provider: "openai", id: "reasoning-model" },
        currentThinkingLevel: "xhigh",
      }),
    ).toEqual([
      {
        slug: "openai/reasoning-model",
        name: "Reasoning Model",
        subProvider: "openai/reasoning-model",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinkingLevel",
              label: "Thinking",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
                { id: "xhigh", label: "Extra High" },
                { id: "max", label: "Max" },
              ],
              currentValue: "xhigh",
            },
          ],
        },
      },
      {
        slug: "openai/fixed-reasoning",
        name: "fixed-reasoning",
        subProvider: "openai/fixed-reasoning",
        isCustom: false,
        capabilities: null,
      },
    ]);
  });

  it("orders OMP models like the native picker and exposes native selectors", () => {
    const models = mapPiFamilyModels({
      runtime: "omp",
      rows: [
        {
          provider: "anthropic",
          id: "claude-3-5-sonnet-20241022",
          name: "Claude Sonnet 3.5 v2",
        },
        {
          provider: "openrouter",
          id: "openai/gpt-5.4",
          name: "GPT-5.4",
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
        },
        {
          provider: "openai-codex",
          id: "gpt-5.4",
          name: "GPT-5.4",
        },
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "GPT-5.6-Sol",
        },
      ],
      currentModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
    });

    expect(models.map((model) => model.slug)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-3-5-sonnet-20241022",
      "openai-codex/gpt-5.4",
      "openrouter/openai/gpt-5.4",
    ]);
    expect(models.map((model) => model.subProvider)).toEqual(models.map((model) => model.slug));
  });

  it("rejects malformed and empty model lists while ignoring malformed rows", () => {
    expect(() => mapPiFamilyModels({ runtime: "pi", rows: { models: [] } })).toThrow(
      "malformed model list",
    );
    expect(() => mapPiFamilyModels({ runtime: "pi", rows: [] })).toThrow("no selectable models");
    expect(
      mapPiFamilyModels({ runtime: "pi", rows: [{ provider: "p", id: "m" }, null] }),
    ).toHaveLength(1);
  });

  it("provides actionable empty-catalog recovery without exposing paths", () => {
    const message = modelDiscoverySnapshotMessage(
      "pi",
      new PiFamilyModelDiscoveryError("empty", "internal detail"),
    );
    expect(message).toBe(
      "pi returned no selectable models. Verify this provider instance's binary, profile, and authentication, then refresh models.",
    );
    expect(message).not.toContain("/Users/");
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
                id: "get_capabilities-1",
                type: "response",
                command: "get_capabilities",
                success: true,
                data: { models: { discover: true } },
              },
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
              {
                id: "get_commands-3",
                type: "response",
                command: "get_commands",
                success: true,
                data: { commands: [{ name: "review", description: "Review changes" }] },
              },
            ),
            commands,
            killed,
          ),
        ),
      );
      expect(result.models[0]?.slug).toBe("p/m");
      expect(result.models[0]?.isDefault).toBe(true);
      expect(result.slashCommands).toEqual([{ name: "review", description: "Review changes" }]);
      expect(killed.value).toBeGreaterThan(0);
      const command = commands[0] as { readonly args: ReadonlyArray<string> };
      expect(command.args.filter((arg) => arg === "--mode")).toHaveLength(1);
    }),
  );

  it.effect("fails an empty native catalog with a typed discovery error", () =>
    Effect.gen(function* () {
      const failure = yield* discoverPiFamilyModels(makeConfig("pi")).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(
            jsonl(
              {
                id: "get_capabilities-1",
                type: "response",
                command: "get_capabilities",
                success: true,
                data: { models: { discover: true } },
              },
              {
                id: "get_state-1",
                type: "response",
                command: "get_state",
                success: true,
                data: { model: null },
              },
              {
                id: "get_available_models-2",
                type: "response",
                command: "get_available_models",
                success: true,
                data: { models: [] },
              },
            ),
            [],
            { value: 0 },
          ),
        ),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(PiFamilyModelDiscoveryError);
      expect(failure.code).toBe("empty");
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
          id: "get_capabilities-1",
          type: "response",
          command: "get_capabilities",
          success: true,
          data: { tasks: { lifecycle: true } },
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
        {
          id: "get_available_commands-3",
          type: "response",
          command: "get_available_commands",
          success: true,
          data: {
            commands: [
              {
                name: "agents",
                aliases: ["agent"],
                description: "Manage agents",
                input: { hint: "<command>" },
              },
            ],
          },
        },
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
      expect(result.slashCommands).toEqual([
        { name: "agents", description: "Manage agents", input: { hint: "<command>" } },
        { name: "agent", description: "Manage agents", input: { hint: "<command>" } },
      ]);
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

it.layer(NodeServices.layer)("Pi-family executable discovery boundaries", (it) => {
  it.effect("probes supported and unsupported native protocol lanes through child processes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-family-probe-" });
      const run = (
        mode:
          | "pi"
          | "omp"
          | "omp-missing-capabilities"
          | "omp-malformed-capabilities"
          | "omp-malformed-id"
          | "omp-empty-capabilities"
          | "omp-bad-ready"
          | "pi-empty",
      ) =>
        Effect.gen(function* () {
          const executablePath = path.join(tempDir, `${mode}.mjs`);
          yield* fs.writeFileString(executablePath, realProbeScript(mode));
          yield* fs.chmod(executablePath, 0o755);
          const runtime = mode.startsWith("omp") ? "omp" : "pi";
          return yield* discoverPiFamilyModels({
            ...makeConfig(runtime),
            binaryPath: process.execPath,
            launchArguments: [executablePath],
            cwd: tempDir,
            requestTimeoutMs: 500,
            startupTimeoutMs: 500,
          });
        });

      const pi = yield* run("pi");
      expect(pi.models.map((model) => model.slug)).toEqual(["probe/model"]);
      expect(pi).toMatchObject({
        slashCommands: [
          { name: "review", description: "Review changes" },
          { name: "skill:ship", description: "Ship the change" },
        ],
      });
      const omp = yield* run("omp");
      expect(omp.models.map((model) => model.slug)).toEqual(["probe/model"]);
      expect(omp).toMatchObject({
        slashCommands: [
          {
            name: "agents",
            description: "Manage agents",
            input: { hint: "<command>" },
          },
          { name: "agent", description: "Manage agents", input: { hint: "<command>" } },
          {
            name: "goal",
            description: "Manage goal mode",
            input: { hint: "[objective]" },
            subcommands: [
              { name: "set", description: "Set the goal", usage: "<objective>" },
              { name: "budget", description: "Adjust token budget", usage: "<N|off>" },
            ],
          },
          { name: "todo", description: "Manage todos" },
        ],
      });

      const missingCapabilities = yield* run("omp-missing-capabilities");
      expect(missingCapabilities.models.map((model) => model.slug)).toEqual(["probe/model"]);

      const malformedCapabilities = yield* run("omp-malformed-capabilities").pipe(Effect.flip);
      expect(malformedCapabilities).toMatchObject({ code: "protocol" });

      const malformedId = yield* run("omp-malformed-id").pipe(Effect.flip);
      expect(malformedId).toMatchObject({ code: "protocol" });

      const emptyCapabilities = yield* run("omp-empty-capabilities");
      expect(emptyCapabilities.models.map((model) => model.slug)).toEqual(["probe/model"]);

      const badReady = yield* run("omp-bad-ready").pipe(Effect.flip);
      expect(badReady).toMatchObject({ code: "protocol" });

      const empty = yield* run("pi-empty").pipe(Effect.flip);
      expect(empty).toMatchObject({ code: "empty" });
    }).pipe(Effect.scoped),
  );
});

it("does not duplicate native mode arguments", () => {
  expect(resolvePiFamilyLaunchArguments(["--mode", "rpc"], "approve-for-this-run")).toEqual([
    "--mode",
    "rpc",
    "--approve",
  ]);
});
