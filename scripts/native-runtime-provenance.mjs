import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const optional = (name) => process.env[name]?.trim() || undefined;
const platform = { Windows: "win32", macOS: "darwin", Linux: "linux" }[required("RUNNER_OS")];
const architecture = { X64: "x64", ARM64: "arm64" }[required("RUNNER_ARCH")];
if (!platform || !architecture)
  throw new Error("Unsupported GitHub runner platform or architecture");

const sha256 = (path) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

const runtimeIdentity = (binary) => {
  const path = NodeFS.realpathSync(binary);
  const versionOutput = NodeChildProcess.execFileSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    ...(platform === "win32" && /\.(?:cmd|bat)$/iu.test(path) ? { shell: true } : {}),
  }).trim();
  if (!versionOutput) throw new Error(`${NodePath.basename(path)} returned an empty version`);
  return { name: NodePath.basename(path), sha256: sha256(path), versionOutput };
};

const outputPath = required("T3_NATIVE_PROVENANCE_REPORT");
const piPackageRoot = NodeFS.realpathSync(required("T3_NATIVE_PI_PACKAGE_ROOT"));
const piPackage = JSON.parse(
  NodeFS.readFileSync(NodePath.join(piPackageRoot, "package.json"), "utf8"),
);
const piVersion = required("T3_NATIVE_PI_VERSION");
if (piPackage.version !== piVersion) {
  throw new Error(`Pi package version mismatch: expected ${piVersion}, got ${piPackage.version}`);
}
const piIntegrity = required("T3_NATIVE_PI_INTEGRITY");
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(piIntegrity)) {
  throw new Error("Pi package integrity is not a sha512 SRI value");
}

const ompSourceHead = required("T3_NATIVE_OMP_SOURCE_HEAD");
if (!/^[0-9a-f]{40}$/u.test(ompSourceHead)) {
  throw new Error("OMP source head is not a full Git SHA");
}
const ompAddonDirectory = NodeFS.realpathSync(required("T3_NATIVE_OMP_ADDON_DIR"));
const ompAddons = NodeFS.readdirSync(ompAddonDirectory)
  .filter((name) => name.endsWith(".node"))
  .sort()
  .map((name) => {
    const path = NodePath.join(ompAddonDirectory, name);
    return { name, sha256: sha256(path), size: NodeFS.statSync(path).size };
  });
if (ompAddons.length === 0) throw new Error("No built OMP native addons were found");

const sourceHead = required("T3_EVIDENCE_SOURCE_HEAD");
if (!/^[0-9a-f]{40}$/u.test(sourceHead)) {
  throw new Error("Evidence source head is not a full Git SHA");
}

const lifecycleRepository = optional("T3_LIFECYCLE_REPOSITORY");
const lifecycleReleaseTag = optional("T3_LIFECYCLE_RELEASE_TAG");
const lifecyclePreviousTag = optional("T3_LIFECYCLE_PREVIOUS_TAG");
if (
  [lifecycleRepository, lifecycleReleaseTag, lifecyclePreviousTag].filter(Boolean).length !== 0 &&
  (!lifecycleRepository || !lifecycleReleaseTag || !lifecyclePreviousTag)
) {
  throw new Error("Lifecycle release provenance must be complete when provided");
}

const report = {
  schemaVersion: 1,
  sourceHead,
  platform,
  architecture,
  release:
    lifecycleRepository && lifecycleReleaseTag && lifecyclePreviousTag
      ? {
          repository: lifecycleRepository,
          currentTag: lifecycleReleaseTag,
          previousTag: lifecyclePreviousTag,
        }
      : null,
  pi: {
    package: piPackage.name,
    version: piPackage.version,
    integrity: piIntegrity,
    binary: runtimeIdentity(required("T3_NATIVE_PI_BINARY")),
  },
  omp: {
    sourceRepository: required("T3_NATIVE_OMP_SOURCE_REPOSITORY"),
    sourceHead: ompSourceHead,
    binary: runtimeIdentity(required("T3_NATIVE_OMP_BINARY")),
    nativeAddons: ompAddons,
  },
};
NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
NodeFS.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
