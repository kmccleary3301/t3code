import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Result from "effect/Result";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { OmpChunkAssembler } from "./OmpChunkAssembler.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";
import {
  asRecord,
  asString,
  isRpcResponse,
  makeOmpNegotiateProtocolCommand,
  parseJsonObject,
  PiFamilyProtocolError,
  validateOmpNegotiateProtocolResponse,
  validateOmpReadyFrame,
  type JsonRecord,
  type PiFamilyRuntimeKind,
  type RpcResponse,
} from "./protocol.ts";

const MAX_DISCOVERY_LINE_BYTES = 1_048_576;
const MAX_DISCOVERY_MESSAGE_BYTES = 67_108_864;
const MAX_DISCOVERY_STDERR_BYTES = 256 * 1024;
const MAX_DISCOVERY_TOTAL_TIMEOUT_MS = 60_000;
const encodeRpcEnvelope = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface PiFamilyModelDiscoveryConfig {
  readonly runtime: PiFamilyRuntimeKind;
  readonly provider: string;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly agentDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launchArguments?: readonly string[];
  readonly trustMode?: string;
  readonly requestTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly maxLineBytes: number;
  readonly maxMessageBytes: number;
  readonly stderrLimitBytes?: number;
}

export interface PiFamilyModelDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
}

export type PiFamilyModelDiscoveryErrorCode =
  | "spawn"
  | "timeout"
  | "protocol"
  | "native"
  | "limit"
  | "empty"
  | "unsupported";

export class PiFamilyModelDiscoveryError extends Error {
  public readonly code: PiFamilyModelDiscoveryErrorCode;

  public constructor(code: PiFamilyModelDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "PiFamilyModelDiscoveryError";
    this.code = code;
  }
}

/** Keep launch behavior identical to native chat sessions. */
export function resolvePiFamilyLaunchArguments(
  launchArguments: readonly string[] | undefined,
  trustMode: string | undefined,
): ReadonlyArray<string> {
  const resolved = [...(launchArguments ?? [])];
  const hasRpcMode = resolved.some(
    (argument) => argument === "--mode" || argument.startsWith("--mode="),
  );
  if (!hasRpcMode) resolved.push("--mode", "rpc");
  if (
    trustMode === "approve-for-this-run" &&
    !resolved.some((argument) => argument === "--approve" || argument === "-a")
  ) {
    resolved.push("--approve");
  } else if (
    trustMode === "deny-for-this-run" &&
    !resolved.some((argument) => argument === "--no-approve" || argument === "-na")
  ) {
    resolved.push("--no-approve");
  }
  return resolved;
}

/** Map only native rows with the provider/id identity needed by NativeAdapter. */
export function mapPiFamilyModels(input: {
  readonly runtime: PiFamilyRuntimeKind;
  readonly rows: unknown;
  readonly currentModel?: unknown;
  readonly currentThinkingLevel?: unknown;
}): ReadonlyArray<ServerProviderModel> {
  if (!Array.isArray(input.rows)) {
    throw new PiFamilyModelDiscoveryError(
      "protocol",
      "Native model discovery returned a malformed model list.",
    );
  }

  const current = asRecord(input.currentModel);
  const currentProvider = nonEmptyString(current?.provider);
  const currentId = nonEmptyString(current?.id);
  const currentSlug =
    currentProvider === undefined || currentId === undefined
      ? undefined
      : `${currentProvider}/${currentId}`;
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const row of input.rows) {
    const model = asRecord(row);
    const provider = nonEmptyString(model?.provider);
    const id = nonEmptyString(model?.id);
    if (provider === undefined || id === undefined) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = nonEmptyString(model?.name) ?? id;
    models.push({
      slug,
      name,
      isCustom: false,
      ...(slug === currentSlug ? { isDefault: true } : {}),
      capabilities: nativeThinkingCapabilities(
        input.runtime,
        model,
        slug === currentSlug ? input.currentThinkingLevel : undefined,
      ),
    });
  }

  if (models.length === 0) {
    throw new PiFamilyModelDiscoveryError(
      "empty",
      "Native model discovery returned no selectable models.",
    );
  }
  return models;
}

export function modelDiscoverySnapshotMessage(provider: string, error: unknown): string {
  const code = error instanceof PiFamilyModelDiscoveryError ? error.code : "native";
  if (code === "timeout") return `${provider} model discovery timed out.`;
  if (code === "empty") {
    return `${provider} returned no selectable models. Verify this provider instance's binary, profile, and authentication, then refresh models.`;
  }
  if (code === "unsupported") {
    return error instanceof PiFamilyModelDiscoveryError
      ? error.message
      : `${provider} native runtime is unsupported.`;
  }
  if (code === "protocol") {
    const auditedVersion = provider === "omp" ? "17.3.7" : "0.84.2";
    return `${provider} returned invalid native protocol data. Configure the audited ${provider} ${auditedVersion} binary and refresh models.`;
  }
  if (code === "limit") return `${provider} model discovery exceeded its output limit.`;
  return `${provider} model discovery failed.`;
}

export const discoverPiFamilyModels = Effect.fn("discoverPiFamilyModels")(function* (
  config: PiFamilyModelDiscoveryConfig,
) {
  const requestTimeoutMs = boundedTimeout(config.requestTimeoutMs, 1);
  const startupTimeoutMs = boundedTimeout(config.startupTimeoutMs, 1);
  const totalTimeoutMs = Math.min(
    MAX_DISCOVERY_TOTAL_TIMEOUT_MS,
    Math.max(requestTimeoutMs, startupTimeoutMs + requestTimeoutMs * 2),
  );
  const run = Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = {
        ...config.environment,
        ...(config.agentDirectory ? { PI_CODING_AGENT_DIR: config.agentDirectory } : {}),
      };
      const launchArguments = resolvePiFamilyLaunchArguments(
        config.launchArguments,
        config.trustMode,
      );
      const spawnCommand = yield* resolveSpawnCommand(config.binaryPath, launchArguments, {
        env: environment,
        extendEnv: true,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: config.cwd,
          env: environment,
          extendEnv: true,
          shell: spawnCommand.shell,
          stdin: { stream: "pipe", endOnDone: false },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );

      const pending = new Map<
        string,
        {
          readonly command: string;
          readonly deferred: Deferred.Deferred<RpcResponse, PiFamilyModelDiscoveryError>;
        }
      >();
      const fatal = yield* Deferred.make<never, PiFamilyModelDiscoveryError>();
      const ready =
        config.runtime === "omp"
          ? yield* Deferred.make<void, PiFamilyModelDiscoveryError>()
          : undefined;
      const decoder = new StrictJsonlDecoder(
        Math.min(Math.max(1, config.maxLineBytes), MAX_DISCOVERY_LINE_BYTES),
      );
      const chunks =
        config.runtime === "omp"
          ? new OmpChunkAssembler(
              Math.min(Math.max(1, config.maxMessageBytes), MAX_DISCOVERY_MESSAGE_BYTES),
            )
          : undefined;
      const stderrLimit = Math.min(
        Math.max(1, config.stderrLimitBytes ?? MAX_DISCOVERY_STDERR_BYTES),
        MAX_DISCOVERY_STDERR_BYTES,
      );
      let stderrBytes = 0;

      const asError = (cause: unknown): PiFamilyModelDiscoveryError => {
        if (cause instanceof PiFamilyModelDiscoveryError) return cause;
        if (cause instanceof PiFamilyProtocolError) {
          return new PiFamilyModelDiscoveryError("protocol", cause.message);
        }
        return new PiFamilyModelDiscoveryError("native", "Native RPC model discovery failed.");
      };
      const signalFailure = (cause: unknown) =>
        Effect.gen(function* () {
          const error = asError(cause);
          yield* Deferred.fail(fatal, error).pipe(Effect.ignore);
          yield* Effect.forEach(
            [...pending.values()],
            ({ deferred }) => Deferred.fail(deferred, error).pipe(Effect.ignore),
            { discard: true },
          );
        });

      const routeFrame = (frame: JsonRecord) =>
        Effect.gen(function* () {
          if (config.runtime === "omp" && frame.type === "ready") {
            yield* Effect.try({
              try: () => validateOmpReadyFrame(frame),
              catch: (cause) => asError(cause),
            });
            if (ready) yield* Deferred.succeed(ready, undefined).pipe(Effect.ignore);
            return;
          }
          if (frame.type !== "response") return;
          if (!isRpcResponse(frame)) {
            return yield* Effect.fail(
              new PiFamilyModelDiscoveryError(
                "protocol",
                "Native model discovery returned a malformed RPC response.",
              ),
            );
          }
          const expectedProtocolVersion = config.runtime === "omp" ? 2 : 1;
          if (
            frame.protocolVersion !== undefined &&
            frame.protocolVersion !== expectedProtocolVersion
          ) {
            return yield* Effect.fail(
              new PiFamilyModelDiscoveryError(
                "protocol",
                `Native model discovery returned unsupported protocol version ${String(frame.protocolVersion)}.`,
              ),
            );
          }
          const id = asString(frame.id);
          if (id === undefined) return;
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          if (frame.command !== request.command) {
            return yield* Effect.fail(
              new PiFamilyModelDiscoveryError(
                "protocol",
                "Native model discovery response command did not match its request.",
              ),
            );
          }
          if (!frame.success) {
            return yield* Deferred.fail(
              request.deferred,
              new PiFamilyModelDiscoveryError("native", "Native model discovery request failed."),
            ).pipe(Effect.ignore);
          }
          yield* Deferred.succeed(request.deferred, frame).pipe(Effect.ignore);
        });
      const processLine = (line: string) =>
        Effect.try({
          try: () => parseJsonObject(line),
          catch: (cause) => asError(cause),
        }).pipe(
          Effect.flatMap((frame) => {
            const complete = chunks ? chunks.accept(frame) : frame;
            return complete === undefined ? Effect.void : routeFrame(complete);
          }),
        );

      const stdoutReader = Stream.runForEach(child.stdout, (chunk) =>
        Effect.try({
          try: () => decoder.push(chunk),
          catch: (cause) => asError(cause),
        }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, processLine, { discard: true }))),
      ).pipe(
        Effect.ensuring(
          Effect.try({
            try: () => decoder.finish(),
            catch: (cause) => asError(cause),
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, processLine, { discard: true })),
            Effect.catch((cause) => signalFailure(cause)),
          ),
        ),
        Effect.catch((cause) => signalFailure(cause)),
        Effect.forkScoped,
      );
      yield* stdoutReader;

      const stderrReader = Stream.runForEach(child.stderr, (chunk) =>
        Effect.gen(function* () {
          stderrBytes += chunk.byteLength;
          if (stderrBytes > stderrLimit) {
            return yield* Effect.fail(
              new PiFamilyModelDiscoveryError(
                "limit",
                "Native model discovery exceeded its stderr limit.",
              ),
            );
          }
        }),
      ).pipe(
        Effect.catch((cause) => signalFailure(cause)),
        Effect.forkScoped,
      );
      yield* stderrReader;

      yield* child.exitCode.pipe(
        Effect.mapError((cause) => asError(cause)),
        Effect.flatMap((code) =>
          signalFailure(
            Number(code) === 0
              ? new PiFamilyModelDiscoveryError(
                  "native",
                  "Native process exited before discovery completed.",
                )
              : new PiFamilyModelDiscoveryError(
                  "native",
                  "Native process exited during model discovery.",
                ),
          ),
        ),
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );

      let requestCounter = 0;
      const request = (command: string, envelope: JsonRecord) => {
        const id = asString(envelope.id) ?? `${command}-${++requestCounter}`;
        return Effect.gen(function* () {
          const deferred = yield* Deferred.make<RpcResponse, PiFamilyModelDiscoveryError>();
          pending.set(id, { command, deferred });
          const requestEnvelope = { ...envelope, id, type: command };
          yield* Stream.run(
            Stream.make(new TextEncoder().encode(`${encodeRpcEnvelope(requestEnvelope)}\n`)),
            child.stdin,
          ).pipe(
            Effect.mapError(
              () => new PiFamilyModelDiscoveryError("native", "Native RPC input failed."),
            ),
          );
          return yield* Deferred.await(deferred).pipe(
            Effect.raceFirst(Deferred.await(fatal)),
            Effect.timeout(requestTimeoutMs),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new PiFamilyModelDiscoveryError("timeout", "Native RPC model discovery timed out."),
              ),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id);
            }),
          ),
        );
      };

      if (ready) {
        yield* Deferred.await(ready).pipe(
          Effect.raceFirst(Deferred.await(fatal)),
          Effect.timeout(startupTimeoutMs),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new PiFamilyModelDiscoveryError("timeout", "OMP did not emit a ready frame."),
            ),
          ),
        );
        const negotiation = yield* request(
          "negotiate_protocol",
          makeOmpNegotiateProtocolCommand("protocol-1"),
        );
        yield* Effect.try({
          try: () => validateOmpNegotiateProtocolResponse(negotiation),
          catch: (cause) => asError(cause),
        });
      }

      const capabilitiesResponse = yield* request("get_capabilities", {
        id: "get_capabilities-1",
        type: "get_capabilities",
      }).pipe(Effect.result);
      if (Result.isFailure(capabilitiesResponse)) {
        if (config.runtime === "omp") {
          const cause = capabilitiesResponse.failure;
          if (cause.code === "protocol") return yield* Effect.fail(cause);
          return yield* Effect.fail(
            new PiFamilyModelDiscoveryError(
              "unsupported",
              "OMP does not implement the T3 `get_capabilities` discovery contract. Configure the audited OMP 17.3.7 integration binary instead of the default OMP 18.0.0 binary.",
            ),
          );
        }
      } else if (
        config.runtime === "omp" &&
        (!asRecord(capabilitiesResponse.success.data) ||
          Object.keys(asRecord(capabilitiesResponse.success.data) ?? {}).length === 0)
      ) {
        return yield* Effect.fail(
          new PiFamilyModelDiscoveryError(
            "unsupported",
            "OMP does not implement the T3 `get_capabilities` discovery contract. Configure the audited OMP 17.3.7 integration binary instead of the default OMP 18.0.0 binary.",
          ),
        );
      }

      const stateResponse = yield* request("get_state", { type: "get_state" });
      const modelsResponse = yield* request("get_available_models", {
        type: "get_available_models",
      });
      const stateData = asRecord(stateResponse.data);
      const modelsData = asRecord(modelsResponse.data);
      if (!stateData || !modelsData || !Array.isArray(modelsData.models)) {
        return yield* Effect.fail(
          new PiFamilyModelDiscoveryError(
            "protocol",
            "Native model discovery returned malformed response data.",
          ),
        );
      }
      const models = yield* Effect.try({
        try: () =>
          mapPiFamilyModels({
            runtime: config.runtime,
            rows: modelsData.models,
            currentModel: stateData.model,
            currentThinkingLevel: stateData.thinkingLevel,
          }),
        catch: (cause) =>
          cause instanceof PiFamilyModelDiscoveryError
            ? cause
            : new PiFamilyModelDiscoveryError(
                "protocol",
                "Native model discovery returned invalid model data.",
              ),
      });
      return { models } satisfies PiFamilyModelDiscoveryResult;
    }),
  );

  return yield* run.pipe(
    Effect.timeout(totalTimeoutMs),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new PiFamilyModelDiscoveryError("timeout", "Native model discovery timed out.")),
    ),
    Effect.mapError((cause) =>
      cause instanceof PiFamilyModelDiscoveryError
        ? cause
        : new PiFamilyModelDiscoveryError("spawn", "Native model discovery could not start."),
    ),
  );
});

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function piFamilyThinkingLevels(
  runtime: PiFamilyRuntimeKind,
  value: unknown,
): ReadonlyArray<(typeof THINKING_LEVELS)[number]> {
  const model = asRecord(value);
  if (model?.reasoning !== true) return [];
  if (runtime === "omp") {
    const thinking = asRecord(model.thinking);
    if (!thinking || !Array.isArray(thinking.efforts)) return [];
    const advertised = new Set(
      thinking.efforts.filter(
        (effort): effort is (typeof THINKING_LEVELS)[number] =>
          typeof effort === "string" &&
          effort !== "off" &&
          THINKING_LEVELS.includes(effort as (typeof THINKING_LEVELS)[number]),
      ),
    );
    return THINKING_LEVELS.filter(
      (level) => (level === "off" && thinking.requiresEffort !== true) || advertised.has(level),
    );
  }
  const levelMap = asRecord(model.thinkingLevelMap);
  return THINKING_LEVELS.filter((level) => {
    const mapped = levelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function nativeThinkingCapabilities(
  runtime: PiFamilyRuntimeKind,
  model: JsonRecord | undefined,
  currentThinkingLevel: unknown,
): ServerProviderModel["capabilities"] {
  const levels = piFamilyThinkingLevels(runtime, model);
  const thinking = runtime === "omp" ? asRecord(model?.thinking) : undefined;
  const current = nonEmptyString(currentThinkingLevel) ?? nonEmptyString(thinking?.defaultLevel);
  return thinkingCapabilities(levels, current);
}

function thinkingCapabilities(
  levels: ReadonlyArray<(typeof THINKING_LEVELS)[number]>,
  currentThinkingLevel: unknown,
): ServerProviderModel["capabilities"] {
  if (levels.length === 0) return null;
  const current = nonEmptyString(currentThinkingLevel);
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: level === "xhigh" ? "Extra High" : `${level[0]?.toUpperCase()}${level.slice(1)}`,
        })),
        ...(current !== undefined && levels.includes(current as (typeof THINKING_LEVELS)[number])
          ? { currentValue: current }
          : {}),
      },
    ],
  });
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function boundedTimeout(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_DISCOVERY_TOTAL_TIMEOUT_MS)
    : fallback;
}
