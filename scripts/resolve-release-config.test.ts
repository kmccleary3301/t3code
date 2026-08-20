import { assert, it } from "@effect/vitest";

import { normalizeRepository, resolveReleaseConfig } from "./resolve-release-config.ts";

it("requires explicit fork release and updater repositories", () => {
  assert.throws(
    () =>
      resolveReleaseConfig({
        profile: "pi-omp",
        currentRepository: "owner/t3-private",
      }),
    /T3_PI_OMP_RELEASE_REPOSITORY/,
  );

  assert.throws(
    () =>
      resolveReleaseConfig({
        profile: "pi-omp",
        currentRepository: "owner/t3-private",
        forkReleaseRepository: "owner/t3-private",
      }),
    /T3CODE_DESKTOP_UPDATE_REPOSITORY/,
  );
});

it("keeps fork release and updater repositories explicit and isolated", () => {
  assert.deepEqual(
    resolveReleaseConfig({
      profile: "pi-omp",
      currentRepository: "owner/t3-private",
      forkReleaseRepository: "https://github.com/owner/t3-private.git",
      updaterRepository: "owner/t3-private",
    }),
    {
      profile: "pi-omp",
      packageName: "t3-pi-omp",
      binaryName: "t3-pi-omp",
      tagPrefix: "fork-v",
      releaseRepository: "owner/t3-private",
      updaterRepository: "owner/t3-private",
    },
  );

  assert.throws(
    () =>
      resolveReleaseConfig({
        profile: "pi-omp",
        currentRepository: "owner/t3-private",
        forkReleaseRepository: "other/t3-private",
        updaterRepository: "other/t3-private",
      }),
    /must match the workflow repository/,
  );
});

it("preserves the upstream repository fallback", () => {
  assert.deepEqual(
    resolveReleaseConfig({
      profile: "upstream",
      currentRepository: "owner/t3code",
    }),
    {
      profile: "upstream",
      packageName: "t3",
      binaryName: "t3",
      tagPrefix: "v",
      releaseRepository: "owner/t3code",
      updaterRepository: "owner/t3code",
    },
  );
  assert.equal(
    normalizeRepository("https://github.com/owner/t3code", "repository"),
    "owner/t3code",
  );
});
