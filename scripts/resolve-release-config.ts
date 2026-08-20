#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";

export type ReleaseProfile = "upstream" | "pi-omp";

export interface ReleaseConfig {
  readonly profile: ReleaseProfile;
  readonly packageName: string;
  readonly binaryName: string;
  readonly tagPrefix: string;
  readonly releaseRepository: string;
  readonly updaterRepository: string;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REPOSITORY_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;

export function normalizeRepository(value: string, name: string): string {
  const trimmed = value.trim();
  const urlMatch = REPOSITORY_URL_PATTERN.exec(trimmed);
  const repository = urlMatch?.[1] ?? trimmed;
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      `${name} must be an owner/repository name or an HTTPS GitHub repository URL; received '${value}'.`,
    );
  }
  return repository;
}

export function resolveReleaseConfig(input: {
  readonly profile: string;
  readonly currentRepository: string;
  readonly forkReleaseRepository?: string | undefined;
  readonly updaterRepository?: string | undefined;
}): ReleaseConfig {
  const profile = input.profile.trim();
  if (profile !== "upstream" && profile !== "pi-omp") {
    throw new Error(`Unsupported product profile '${input.profile}'.`);
  }

  const currentRepository = normalizeRepository(input.currentRepository, "GITHUB_REPOSITORY");
  const configuredReleaseRepository = input.forkReleaseRepository?.trim() ?? "";
  const configuredUpdaterRepository = input.updaterRepository?.trim() ?? "";

  if (profile === "pi-omp" && configuredReleaseRepository.length === 0) {
    throw new Error(
      "T3_PI_OMP_RELEASE_REPOSITORY is required for pi-omp releases; refusing to use an implicit repository.",
    );
  }
  if (profile === "pi-omp" && configuredUpdaterRepository.length === 0) {
    throw new Error(
      "T3CODE_DESKTOP_UPDATE_REPOSITORY is required for pi-omp releases; refusing to point updates at an implicit repository.",
    );
  }

  const releaseRepository =
    profile === "pi-omp"
      ? normalizeRepository(configuredReleaseRepository, "T3_PI_OMP_RELEASE_REPOSITORY")
      : currentRepository;
  const updaterRepository = normalizeRepository(
    configuredUpdaterRepository.length > 0 ? configuredUpdaterRepository : releaseRepository,
    "T3CODE_DESKTOP_UPDATE_REPOSITORY",
  );

  if (profile === "pi-omp" && releaseRepository !== currentRepository) {
    throw new Error(
      `T3_PI_OMP_RELEASE_REPOSITORY (${releaseRepository}) must match the workflow repository (${currentRepository}) so GitHub can publish the release there.`,
    );
  }

  return profile === "pi-omp"
    ? {
        profile,
        packageName: "t3-pi-omp",
        binaryName: "t3-pi-omp",
        tagPrefix: "fork-v",
        releaseRepository,
        updaterRepository,
      }
    : {
        profile,
        packageName: "t3",
        binaryName: "t3",
        tagPrefix: "v",
        releaseRepository,
        updaterRepository,
      };
}

function appendGithubOutput(config: ReleaseConfig): void {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) return;
  const lines = [
    ["product_profile", config.profile],
    ["cli_package_name", config.packageName],
    ["cli_binary_name", config.binaryName],
    ["release_tag_prefix", config.tagPrefix],
    ["release_repository", config.releaseRepository],
    ["updater_repository", config.updaterRepository],
  ];
  NodeFS.appendFileSync(
    outputPath,
    `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
}

function readFlag(args: ReadonlyArray<string>, name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function requiredFlag(args: ReadonlyArray<string>, name: string): string {
  const value = readFlag(args, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const config = resolveReleaseConfig({
      profile: requiredFlag(args, "--profile"),
      currentRepository: requiredFlag(args, "--current-repository"),
      forkReleaseRepository: readFlag(args, "--fork-release-repository"),
      updaterRepository: readFlag(args, "--updater-repository"),
    });
    appendGithubOutput(config);
    if (!process.env.GITHUB_OUTPUT) process.stdout.write(`${JSON.stringify(config)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
