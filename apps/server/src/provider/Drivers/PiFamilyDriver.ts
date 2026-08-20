import {
  OmpSettings,
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ProviderDriverCreateInput } from "../ProviderDriver.ts";
import {
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makePiFamilyAdapter } from "../piFamily/NativeAdapter.ts";
import { makePiFamilyTextGeneration } from "../../textGeneration/PiFamilyTextGeneration.ts";

export type PiFamilySettings = typeof PiSettings.Type | typeof OmpSettings.Type;

const maintenance = (provider: ProviderDriverKind): ProviderMaintenanceCapabilities => ({
  provider,
  packageName: null,
  update: null,
});

function makeSnapshot(
  input: ProviderDriverCreateInput<PiFamilySettings>,
  provider: ProviderDriverKind,
  dependencies: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly cwd: string;
  },
): ServerProviderShape {
  const config = input.config;
  const environment = resolvePiFamilyEnvironment(
    {
      ...process.env,
      ...config.environment,
      ...(config.agentDirectory ? { PI_CODING_AGENT_DIR: config.agentDirectory } : {}),
    },
    input.environment,
  );
  const check = Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const base = {
      instanceId: input.instanceId,
      driver: provider,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: `${provider}:instance:${input.instanceId}` },
      enabled: input.enabled,
      models: [],
      slashCommands: [],
      skills: [],
      availability: "available" as const,
    };
    if (!input.enabled) {
      return {
        ...base,
        installed: false,
        version: null,
        status: "disabled" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: "Provider is disabled in settings.",
      } satisfies ServerProvider;
    }
    const probe = yield* spawnAndCollect(
      config.binaryPath,
      ChildProcess.make(config.binaryPath, ["--version"], {
        cwd: dependencies.cwd,
        env: environment,
        extendEnv: false,
      }),
    ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(probe)) {
      const cause = probe.failure;
      return {
        ...base,
        installed: !isCommandMissingCause(cause),
        version: null,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: isCommandMissingCause(cause)
          ? `${provider} binary is not installed or not on PATH.`
          : `${provider} version probe failed.`,
      } satisfies ServerProvider;
    }
    if (probe.success._tag === "None") {
      return {
        ...base,
        installed: true,
        version: null,
        status: "error" as const,
        auth: { status: "unknown" as const },
        checkedAt,
        message: `${provider} version probe timed out.`,
      } satisfies ServerProvider;
    }
    const result = probe.success.value;
    const version = parseGenericCliVersion(`${result.stdout}\n${result.stderr}`);
    return {
      ...base,
      installed: true,
      version,
      status: result.code === 0 ? ("ready" as const) : ("error" as const),
      auth: { status: "unknown" as const },
      checkedAt,
      ...(result.code === 0 ? {} : { message: `${provider} version probe exited unsuccessfully.` }),
    } satisfies ServerProvider;
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, dependencies.spawner));
  return {
    maintenanceCapabilities: maintenance(provider),
    getSnapshot: check,
    refresh: check,
    streamChanges: Stream.empty,
  };
}
export function resolvePiFamilyEnvironment(
  configEnvironment: Readonly<Record<string, string | undefined>>,
  instanceEnvironment: ProviderDriverCreateInput<PiFamilySettings>["environment"],
): NodeJS.ProcessEnv {
  return mergeProviderInstanceEnvironment(instanceEnvironment, {
    ...process.env,
    ...configEnvironment,
  });
}

function makeAdapter(
  input: ProviderDriverCreateInput<PiFamilySettings>,
  provider: ProviderDriverKind,
): Effect.Effect<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope | ServerConfig
> {
  const config = input.config;
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const processEnvironment = resolvePiFamilyEnvironment(
      {
        ...config.environment,
        ...(config.agentDirectory ? { PI_CODING_AGENT_DIR: config.agentDirectory } : {}),
      },
      input.environment,
    );
    return yield* makePiFamilyAdapter({
      provider,
      runtime: provider === "omp" ? "omp" : "pi",
      binaryPath: config.binaryPath,
      cwd: serverConfig.cwd,
      ...(config.agentDirectory ? { agentDirectory: config.agentDirectory } : {}),
      attachmentsDir: serverConfig.attachmentsDir,
      environment: processEnvironment,
      launchArguments: config.launchArguments,
      trustMode: config.trustMode,
      requestTimeoutMs: config.requestTimeoutMs,
      startupTimeoutMs: config.startupTimeoutMs,
      maxLineBytes: config.maxLineBytes,
      maxMessageBytes: config.maxMessageBytes,
      stderrLimitBytes: 256 * 1024,
      instanceId: input.instanceId,
    });
  });
}

function makeTextGeneration(
  provider: ProviderDriverKind,
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): ProviderInstance["textGeneration"] {
  return makePiFamilyTextGeneration({ provider, adapter });
}

export function makePiFamilyDriver<Config extends PiFamilySettings>(input: {
  readonly provider: ProviderDriverKind;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly displayName: string;
}): ProviderDriver<Config, ChildProcessSpawner.ChildProcessSpawner | ServerConfig> {
  return {
    driverKind: input.provider,
    metadata: { displayName: input.displayName, supportsMultipleInstances: true },
    configSchema: input.configSchema,
    defaultConfig: input.defaultConfig,
    create: (createInput) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const serverConfig = yield* ServerConfig;
        const adapter = yield* makeAdapter(createInput, input.provider);
        const textGenerationAdapter = yield* makeAdapter(createInput, input.provider);
        return {
          instanceId: createInput.instanceId,
          driverKind: input.provider,
          continuationIdentity: defaultProviderContinuationIdentity({
            driverKind: input.provider,
            instanceId: createInput.instanceId,
          }),
          displayName: createInput.displayName,
          accentColor: createInput.accentColor,
          enabled: createInput.enabled,
          snapshot: makeSnapshot(createInput, input.provider, {
            spawner,
            cwd: serverConfig.cwd,
          }),
          adapter,
          textGeneration: makeTextGeneration(input.provider, textGenerationAdapter),
        } satisfies ProviderInstance;
      }),
  };
}
