// @effect-diagnostics nodeBuiltinImport:off - Runtime release verification uses Node streams and adjacent package metadata.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  parseProductProfile,
  resolveProductIdentity,
  type ProductProfile,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as ProcessRunner from "../processRunner.ts";

const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_REPOSITORY_ENV = "T3_PI_OMP_RELEASE_REPOSITORY";
const MAX_RELEASE_METADATA_BYTES = 1_048_576;
const MAX_RELEASE_PACKAGE_BYTES = 512 * 1_024 * 1_024;
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJsonSync = Schema.decodeUnknownSync(UnknownFromJsonString);
const decodeUnknownJsonPromise = Schema.decodeUnknownPromise(UnknownFromJsonString);

export interface RuntimeIdentityInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: ReadonlyArray<string>;
}

export function resolveRuntimePackageName(input: RuntimeIdentityInput = {}): string {
  const env = input.env ?? process.env;
  const configuredPackageName = env.T3_PRODUCT_PACKAGE_NAME?.trim();
  if (configuredPackageName !== undefined && SAFE_PACKAGE_NAME.test(configuredPackageName)) {
    return configuredPackageName;
  }

  const configuredProfile = env.T3_PRODUCT_PROFILE?.trim();
  if (configuredProfile === "pi-omp") {
    return resolveProductIdentity("pi-omp").packageName;
  }
  if (configuredProfile === "upstream") {
    return resolveProductIdentity("upstream").packageName;
  }

  const entryPath = (input.argv ?? process.argv)[1]?.replaceAll("\\", "/");
  const entryName = entryPath?.slice(entryPath.lastIndexOf("/") + 1).replace(/\.cmd$/iu, "");
  const forkIdentity = resolveProductIdentity("pi-omp");
  if (entryName === forkIdentity.cliBinaryName) return forkIdentity.packageName;

  const packageMatch = entryPath?.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/dist\/bin\.mjs$/u);
  if (packageMatch?.[1] !== undefined && SAFE_PACKAGE_NAME.test(packageMatch[1])) {
    return packageMatch[1];
  }

  return resolveProductIdentity(parseProductProfile(configuredProfile)).packageName;
}
function normalizeGitHubRepository(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (SAFE_REPOSITORY.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
    const repository = url.pathname.replace(/^\/+/u, "").replace(/\.git$/u, "");
    return SAFE_REPOSITORY.test(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

export function resolveRuntimeReleaseRepository(
  input: RuntimeIdentityInput = {},
): string | undefined {
  const env = input.env ?? process.env;
  const configured = normalizeGitHubRepository(env[RELEASE_REPOSITORY_ENV]);
  if (configured) return configured;

  const entryPath = (input.argv ?? process.argv)[1];
  if (!entryPath) return undefined;
  try {
    const packageJsonPath = NodePath.resolve(NodePath.dirname(entryPath), "..", "package.json");
    const packageJson = decodeUnknownJsonSync(NodeFS.readFileSync(packageJsonPath, "utf8")) as {
      readonly repository?: string | { readonly url?: string };
    };
    return normalizeGitHubRepository(
      typeof packageJson.repository === "string"
        ? packageJson.repository
        : packageJson.repository?.url,
    );
  } catch {
    return undefined;
  }
}

export function resolveRuntimeProductProfile(input: RuntimeIdentityInput = {}): ProductProfile {
  const configuredProfile = input.env?.T3_PRODUCT_PROFILE ?? process.env.T3_PRODUCT_PROFILE;
  if (configuredProfile?.trim() === "pi-omp") return "pi-omp";
  if (configuredProfile?.trim() === "upstream") return "upstream";
  return resolveRuntimePackageName(input) === resolveProductIdentity("pi-omp").packageName
    ? "pi-omp"
    : "upstream";
}

/**
 * A pinned runtime is an exact `t3@<version>` npm-installed into
 * <baseDir>/runtime/versions/<version>. The boot service points its unit or
 * launch agent here, and server self-update installs the target version here before
 * switching over, never `npx t3`, whose cache is ephemeral and whose
 * registry fetch at boot would make startup depend on the network.
 */

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  packageName = resolveRuntimePackageName(),
): PinnedRuntimePaths {
  const versionDir = path.join(baseDir, PINNED_RUNTIME_DIR, "versions", version);
  return {
    versionDir,
    entryPath: path.join(versionDir, "node_modules", packageName, "dist", "bin.mjs"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedErrorClass<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedErrorClass<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}
export type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function sha256(value: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function checksumFor(sums: string, filename: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/iu);
    if (!match) continue;
    const candidate = match[2]?.replace(/^\.\//u, "");
    if (candidate === filename) return match[1]?.toLowerCase();
  }
  return undefined;
}

async function fetchReleaseMetadata(
  fetcher: RuntimeFetch,
  url: string,
  label: string,
): Promise<Uint8Array> {
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error(`${label} redirected outside HTTPS.`);
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RELEASE_METADATA_BYTES) {
    throw new Error(`${label} exceeds the metadata size limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RELEASE_METADATA_BYTES) {
    throw new Error(`${label} has an invalid size.`);
  }
  return bytes;
}

async function downloadReleasePackage(
  fetcher: RuntimeFetch,
  url: string,
  destination: string,
): Promise<string> {
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`CLI package returned HTTP ${response.status}.`);
  if (response.url && new URL(response.url).protocol !== "https:") {
    throw new Error("CLI package redirected outside HTTPS.");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RELEASE_PACKAGE_BYTES) {
    throw new Error("CLI package exceeds the release size limit.");
  }
  if (!response.body) throw new Error("CLI package response has no body.");

  let received = 0;
  const digest = NodeCrypto.createHash("sha256");
  const verifier = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > MAX_RELEASE_PACKAGE_BYTES) {
        callback(new Error("CLI package exceeds the release size limit."));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await NodeStreamPromises.pipeline(
    NodeStream.Readable.fromWeb(response.body as never),
    verifier,
    NodeFS.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  if (received === 0) throw new Error("CLI package is empty.");
  return digest.digest("hex");
}

function releaseManifestArtifact(
  value: unknown,
  input: {
    readonly version: string;
    readonly packageName: string;
    readonly filename: string;
    readonly repository: string;
    readonly tag: string;
  },
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Release manifest is not an object.");
  }
  const manifest = value as Record<string, unknown>;
  const packageRecord =
    typeof manifest.package === "object" && manifest.package !== null
      ? (manifest.package as Record<string, unknown>)
      : undefined;
  if (
    manifest.profile !== "pi-omp" ||
    manifest.version !== input.version ||
    manifest.packageName !== input.packageName ||
    manifest.repository !== input.repository ||
    manifest.tag !== input.tag ||
    packageRecord?.name !== input.packageName ||
    packageRecord.version !== input.version
  ) {
    throw new Error("Release manifest identity does not match the requested fork runtime.");
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("Release manifest has no artifacts.");
  }
  const artifact = manifest.artifacts.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).name === input.filename &&
      (candidate as Record<string, unknown>).kind === "cli",
  ) as Record<string, unknown> | undefined;
  if (
    !artifact ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/iu.test(artifact.sha256)
  ) {
    throw new Error("Release manifest has no valid fork CLI artifact.");
  }
  return artifact.sha256.toLowerCase();
}

function prepareForkReleasePackage(input: {
  readonly repository: string;
  readonly version: string;
  readonly packageName: string;
  readonly destination: string;
  readonly fetcher: RuntimeFetch;
}): Effect.Effect<string, PinnedRuntimeInstallError> {
  return Effect.tryPromise({
    try: async () => {
      const identity = resolveProductIdentity("pi-omp");
      const tag = `${identity.releaseTagPrefix}${input.version}`;
      const filename = `${input.packageName}-${input.version}.tgz`;
      const releaseBase = `https://github.com/${input.repository}/releases/download/${encodeURIComponent(tag)}`;
      const sumsBytes = await fetchReleaseMetadata(
        input.fetcher,
        `${releaseBase}/SHA256SUMS`,
        "SHA256SUMS",
      );
      const manifestBytes = await fetchReleaseMetadata(
        input.fetcher,
        `${releaseBase}/RELEASE-MANIFEST.json`,
        "RELEASE-MANIFEST.json",
      );
      const sums = Buffer.from(sumsBytes).toString("utf8");
      const expectedManifest = checksumFor(sums, "RELEASE-MANIFEST.json");
      if (!expectedManifest || sha256(manifestBytes) !== expectedManifest) {
        throw new Error("Release manifest checksum verification failed.");
      }
      const manifestChecksum = releaseManifestArtifact(
        await decodeUnknownJsonPromise(Buffer.from(manifestBytes).toString("utf8")),
        {
          version: input.version,
          packageName: input.packageName,
          filename,
          repository: input.repository,
          tag,
        },
      );
      const sumsChecksum = checksumFor(sums, filename);
      if (!sumsChecksum || sumsChecksum !== manifestChecksum) {
        throw new Error("CLI package manifest and checksum records disagree.");
      }
      const downloadedChecksum = await downloadReleasePackage(
        input.fetcher,
        `${releaseBase}/${encodeURIComponent(filename)}`,
        input.destination,
      );
      if (downloadedChecksum !== manifestChecksum) {
        throw new Error("CLI package checksum verification failed.");
      }
      return input.destination;
    },
    catch: (cause) =>
      new PinnedRuntimeInstallError({
        step: "downloading and verifying the fork release package",
        cause,
      }),
  });
}

/**
 * Installs `t3@<version>` into the pinned runtime directory unless a complete
 * install is already there, and returns its paths. The sentinel is written
 * only after npm exits 0; checking the entry file alone is not enough. npm
 * extracts files before running native builds (node-pty), so a killed
 * install leaves a plausible-looking but broken tree behind.
 */
interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly packageName?: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly releaseRepository?: string;
  readonly fetch?: RuntimeFetch;
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
}

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs, runner } = input;
  const packageName = input.packageName ?? resolveRuntimePackageName();
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version, packageName);
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const alreadyPinned =
    entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version;
  if (alreadyPinned) {
    yield* input.validate(paths);
    return paths;
  }
  if (versionDirExists) {
    yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "removing an incomplete pinned runtime",
            cause,
          }),
      ),
    );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, "node_modules", packageName, "dist", "bin.mjs"),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    const releaseRepository =
      packageName === resolveProductIdentity("pi-omp").packageName
        ? (input.releaseRepository ?? resolveRuntimeReleaseRepository())
        : undefined;
    const packageArchive = input.path.join(stagingDir, `${packageName}-${input.version}.tgz`);
    const installSource = releaseRepository
      ? yield* prepareForkReleasePackage({
          repository: releaseRepository,
          version: input.version,
          packageName,
          destination: packageArchive,
          fetcher: input.fetch ?? globalThis.fetch,
        })
      : `${packageName}@${input.version}`;
    const installStep = `installing the pinned ${packageName} runtime (this can take a few minutes)`;
    yield* runner
      .run({
        command: "npm",
        args: ["install", "--prefix", stagingDir, "--no-fund", "--no-audit", installSource],
        // Native dependencies may compile from source on slower machines.
        timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
      })
      .pipe(
        Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: installStep, cause })),
        Effect.filterOrFail(
          (result) => result.code === 0,
          (result) =>
            new PinnedRuntimeInstallError({
              step: installStep,
              exitCode: Number(result.code),
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
        ),
      );
    if (releaseRepository) {
      yield* fs.remove(packageArchive, { force: true }).pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "removing the verified release package",
              cause,
            }),
        ),
      );
    }

    yield* input.validate(stagingPaths);
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    const published = yield* fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            publishedSentinel.value.trim() === input.version
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!published) yield* input.validate(paths);
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));
