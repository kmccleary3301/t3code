import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

import {
  parsePiFamilyCliVersion,
  piFamilyVersionCompatibilityError,
  resolvePiFamilyEnvironment,
  resolvePiFamilyWorkingDirectory,
} from "./PiFamilyDriver.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { spawnAndCollect } from "../providerSnapshot.ts";

describe("Pi-family driver environment isolation", () => {
  it("merges instance variables over config variables without sharing instances", () => {
    const configEnvironment = {
      PI_PROFILE: "default",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    };
    const personal = resolvePiFamilyEnvironment(configEnvironment, [
      { name: "PI_PROFILE", value: "personal", sensitive: false },
      { name: "INSTANCE_ONLY", value: "personal-only", sensitive: false },
    ]);
    const work = resolvePiFamilyEnvironment(configEnvironment, [
      { name: "PI_PROFILE", value: "work", sensitive: false },
      { name: "INSTANCE_ONLY", value: "work-only", sensitive: false },
    ]);

    expect(personal).toMatchObject({
      PI_PROFILE: "personal",
      INSTANCE_ONLY: "personal-only",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    });
    expect(work).toMatchObject({
      PI_PROFILE: "work",
      INSTANCE_ONLY: "work-only",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    });
    expect(personal).not.toBe(work);
    expect(configEnvironment).toEqual({
      PI_PROFILE: "default",
      SHARED_VALUE: "config",
      CONFIG_ONLY: "kept",
    });
  });
});

describe("Pi-family driver working-directory isolation", () => {
  it("uses an instance directory without changing the server fallback", () => {
    expect(resolvePiFamilyWorkingDirectory("/work/personal", "/server")).toBe("/work/personal");
    expect(resolvePiFamilyWorkingDirectory("/work/team", "/server")).toBe("/work/team");
    expect(resolvePiFamilyWorkingDirectory("", "/server")).toBe("/server");
  });
});

it.effect("probes version compatibility through real executable children", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-version-probe-" });
    const executablePath = path.join(tempDir, "version-probe.mjs");
    const probe = (output: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(
          executablePath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Emit an exact quoted child stdout literal.
          ["#!/usr/bin/env node", `process.stdout.write(${JSON.stringify(output)});`].join("\n"),
        );
        yield* fs.chmod(executablePath, 0o755);
        const spawnCommand = yield* resolveSpawnCommand(executablePath, ["--version"]);
        return yield* spawnAndCollect(
          executablePath,
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: tempDir,
            env: process.env,
            extendEnv: false,
            shell: spawnCommand.shell,
          }),
        );
      });

    const pi = yield* probe("pi 0.84.2+audited.1");
    const piVersion = parsePiFamilyCliVersion(`${pi.stdout}\n${pi.stderr}`);
    expect(piVersion).toBe("0.84.2");
    expect(piFamilyVersionCompatibilityError("pi", piVersion)).toBeUndefined();

    const omp = yield* probe("omp 17.3.7+audited.1");
    const ompVersion = parsePiFamilyCliVersion(`${omp.stdout}\n${omp.stderr}`);
    expect(ompVersion).toBe("17.3.7");
    expect(piFamilyVersionCompatibilityError("omp", ompVersion)).toBeUndefined();

    const unsupported = yield* probe("omp 18.0.0");
    const unsupportedVersion = parsePiFamilyCliVersion(
      `${unsupported.stdout}\n${unsupported.stderr}`,
    );
    expect(piFamilyVersionCompatibilityError("omp", unsupportedVersion)).toContain(
      "get_capabilities",
    );

    const malformed = yield* probe("");
    const malformedVersion = parsePiFamilyCliVersion(`${malformed.stdout}\n${malformed.stderr}`);
    expect(malformedVersion).toBeNull();
    expect(piFamilyVersionCompatibilityError("omp", malformedVersion)).toContain(
      "could not be parsed",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
