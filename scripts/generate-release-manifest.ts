#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { normalizeRepository } from "./resolve-release-config.ts";

type ReleaseProfile = "upstream" | "pi-omp";

type SigningRecord = {
  readonly signed: boolean;
  readonly artifacts?: ReadonlyArray<string>;
};

export interface ReleaseArtifact {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind:
    | "cli"
    | "desktop"
    | "installer"
    | "update-metadata"
    | "runtime"
    | "native"
    | "other";
  readonly runtime?: "pi" | "omp";
  readonly native?: "node-pty";
  readonly platform?: "darwin" | "linux" | "windows";
  readonly arch?: "arm64" | "x64";
  readonly signed: boolean;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly profile: ReleaseProfile;
  readonly package: {
    readonly name: string;
    readonly bin: string;
    readonly version: string;
  };
  readonly packageName: string;
  readonly bin: string;
  readonly client: { readonly version: string };
  readonly server: { readonly version: string };
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly version: string;
  readonly channel: "stable" | "nightly";
  readonly tag: string;
  readonly commit: string;
  readonly repository: string;
  readonly updaterRepository: string;
  readonly artifacts: ReadonlyArray<ReleaseArtifact>;
  readonly unsignedArtifacts: ReadonlyArray<string>;
}

function flag(args: ReadonlyArray<string>, name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required.`);
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function packageVersion(root: string, relativePath: string): string {
  const value = readJson(NodePath.join(root, relativePath)).version;
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`Invalid package version in ${relativePath}.`);
  }
  return value;
}

function runtimeDetails(name: string):
  | {
      readonly runtime: "pi" | "omp";
      readonly platform: "darwin" | "linux";
      readonly arch: "arm64" | "x64";
    }
  | undefined {
  const match = /^(pi|omp)-runtime-(darwin|linux)-(arm64|x64)\.(?:tar\.gz|tgz|zip)$/iu.exec(name);
  if (!match) return undefined;
  return {
    runtime: match[1]!.toLowerCase() as "pi" | "omp",
    platform: match[2]!.toLowerCase() as "darwin" | "linux",
    arch: match[3]!.toLowerCase() as "arm64" | "x64",
  };
}

function desktopDetails(name: string):
  | {
      readonly platform: "darwin" | "linux" | "windows";
      readonly arch: "arm64" | "x64";
    }
  | undefined {
  const match = /-(arm64|x64|x86_64)\.(dmg|zip|appimage|exe)(?:\.blockmap)?$/iu.exec(name);
  if (!match) return undefined;
  const extension = match[2]!.toLowerCase();
  const platform = extension === "appimage" ? "linux" : extension === "exe" ? "windows" : "darwin";
  return {
    platform,
    arch: match[1]!.toLowerCase() === "arm64" ? "arm64" : "x64",
  };
}
function nativeDetails(name: string):
  | {
      readonly native: "node-pty";
      readonly platform: "linux";
      readonly arch: "arm64" | "x64";
    }
  | undefined {
  const match = /^node-pty-(linux)-(arm64|x64)\.tar\.gz$/iu.exec(name);
  if (!match) return undefined;
  return {
    native: "node-pty",
    platform: "linux",
    arch: match[2]!.toLowerCase() === "arm64" ? "arm64" : "x64",
  };
}

function artifactKind(name: string): ReleaseArtifact["kind"] {
  if (runtimeDetails(name)) return "runtime";
  if (nativeDetails(name)) return "native";
  if (name.endsWith(".tgz")) return "cli";
  if (name === "install.sh") return "installer";
  if (name.endsWith(".yml")) return "update-metadata";
  if (/\.(?:dmg|zip|appimage|exe|blockmap)$/iu.test(name)) return "desktop";
  return "other";
}

function signingRecords(assetDirectory: string): Map<string, SigningRecord> {
  const records = new Map<string, SigningRecord>();
  for (const name of NodeFS.readdirSync(assetDirectory)) {
    if (!name.startsWith("t3-artifact-signing-") || !name.endsWith(".json")) continue;
    const raw = readJson(NodePath.join(assetDirectory, name));
    const signed = raw.signed;
    if (typeof signed !== "boolean") throw new Error(`Invalid signing record ${name}.`);
    const artifacts = Array.isArray(raw.artifacts)
      ? raw.artifacts.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    records.set(name, artifacts === undefined ? { signed } : { signed, artifacts });
  }
  return records;
}

function signedForArtifact(name: string, records: ReadonlyMap<string, SigningRecord>): boolean {
  for (const record of records.values()) {
    if (record.artifacts?.includes(name)) return record.signed;
  }
  // A release produced without the build-job marker is explicitly unsigned.
  return false;
}

export function generateReleaseManifest(input: {
  readonly root: string;
  readonly assetsDirectory: string;
  readonly outputPath: string;
  readonly profile: ReleaseProfile;
  readonly channel: "stable" | "nightly";
  readonly tag: string;
  readonly commit: string;
  readonly repository: string;
  readonly updaterRepository: string;
}): ReleaseManifest {
  const packageName = input.profile === "pi-omp" ? "t3-pi-omp" : "t3";
  const binaryName = packageName;
  const versions = {
    server: packageVersion(input.root, "apps/server/package.json"),
    client: packageVersion(input.root, "apps/web/package.json"),
    desktop: packageVersion(input.root, "apps/desktop/package.json"),
  };
  if (versions.server !== versions.client || versions.server !== versions.desktop) {
    throw new Error(
      `Release package versions must match (server ${versions.server}, client ${versions.client}, desktop ${versions.desktop}).`,
    );
  }
  if (!/^[0-9a-f]{7,64}$/iu.test(input.commit))
    throw new Error("Release commit must be a hexadecimal SHA.");
  if (!/^(?:v|fork-v)\d+\.\d+\.\d+/u.test(input.tag))
    throw new Error(`Invalid release tag '${input.tag}'.`);
  const expectedTagPrefix = input.profile === "pi-omp" ? "fork-v" : "v";
  if (!input.tag.startsWith(expectedTagPrefix)) {
    throw new Error(`Release tag '${input.tag}' does not match ${input.profile} profile.`);
  }

  const repository = normalizeRepository(input.repository, "release repository");
  const updaterRepository = normalizeRepository(input.updaterRepository, "updater repository");
  const records = signingRecords(input.assetsDirectory);
  const files = NodeFS.readdirSync(input.assetsDirectory)
    .filter(
      (name) =>
        !name.startsWith("t3-artifact-signing-") &&
        name !== "SHA256SUMS" &&
        name !== "RELEASE-MANIFEST.json",
    )
    .sort((left, right) => left.localeCompare(right));
  const artifacts = files.map((name): ReleaseArtifact => {
    const path = NodePath.join(input.assetsDirectory, name);
    const stat = NodeFS.statSync(path);
    if (!stat.isFile()) throw new Error(`Release asset is not a regular file: ${name}`);
    const runtime = runtimeDetails(name);
    const kind = artifactKind(name);
    const native = kind === "native" ? nativeDetails(name) : undefined;
    const desktop = kind === "desktop" ? desktopDetails(name) : undefined;
    return {
      name,
      path: name,
      size: stat.size,
      sha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
      kind,
      ...(native ?? runtime ?? desktop),
      signed: signedForArtifact(name, records),
    };
  });
  const unsignedArtifacts = artifacts
    .filter((artifact) => !artifact.signed)
    .map((artifact) => artifact.name);
  if (!artifacts.some((artifact) => artifact.kind === "cli")) {
    throw new Error("Release assets must include the profile-specific CLI package tarball.");
  }
  if (!artifacts.some((artifact) => artifact.kind === "desktop")) {
    throw new Error("Release assets must include at least one desktop artifact.");
  }

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    profile: input.profile,
    package: { name: packageName, bin: binaryName, version: versions.server },
    packageName,
    bin: binaryName,
    client: { version: versions.client },
    server: { version: versions.server },
    clientVersion: versions.client,
    serverVersion: versions.server,
    version: versions.server,
    channel: input.channel,
    tag: input.tag,
    commit: input.commit,
    repository,
    updaterRepository,
    artifacts,
    unsignedArtifacts,
  };
  NodeFS.writeFileSync(input.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const profile = flag(args, "--profile") as ReleaseProfile;
    if (profile !== "upstream" && profile !== "pi-omp")
      throw new Error(`Unsupported profile '${profile}'.`);
    const channel = flag(args, "--channel");
    if (channel !== "stable" && channel !== "nightly")
      throw new Error(`Unsupported channel '${channel}'.`);
    generateReleaseManifest({
      root: flag(args, "--root")!,
      assetsDirectory: flag(args, "--assets")!,
      outputPath: flag(args, "--output")!,
      profile,
      channel,
      tag: flag(args, "--tag")!,
      commit: flag(args, "--commit")!,
      repository: flag(args, "--repository")!,
      updaterRepository: flag(args, "--updater-repository")!,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
