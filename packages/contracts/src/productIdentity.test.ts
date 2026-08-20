import { assert, it } from "@effect/vitest";

import {
  parseProductProfile,
  resolveProductIdentity,
  resolveProductUpdateRepository,
} from "./productIdentity.ts";

it("keeps the Pi + OMP product installable beside upstream T3 Code", () => {
  const upstream = resolveProductIdentity("upstream");
  const piOmp = resolveProductIdentity("pi-omp");

  assert.notEqual(upstream.packageName, piOmp.packageName);
  assert.notEqual(upstream.cliBinaryName, piOmp.cliBinaryName);
  assert.notEqual(upstream.bundleIdentifier, piOmp.bundleIdentifier);
  assert.notEqual(upstream.stateDirectoryName, piOmp.stateDirectoryName);
  assert.notEqual(upstream.productionScheme, piOmp.productionScheme);
  assert.notEqual(upstream.releaseTagPrefix, piOmp.releaseTagPrefix);
  assert.equal(piOmp.packageName, "t3-pi-omp");
  assert.equal(piOmp.cliBinaryName, "t3-pi-omp");
  assert.equal(piOmp.releaseTagPrefix, "fork-v");
});

it("requires an explicit owner-controlled updater repository for fork builds", () => {
  assert.equal(resolveProductUpdateRepository("pi-omp", {}), undefined);
  assert.equal(
    resolveProductUpdateRepository("pi-omp", {
      T3CODE_DESKTOP_UPDATE_REPOSITORY: "owner/t3code-pi-omp",
    }),
    "owner/t3code-pi-omp",
  );
});

it("fails closed to the upstream profile for unknown configuration", () => {
  assert.equal(parseProductProfile(undefined), "upstream");
  assert.equal(parseProductProfile("unknown"), "upstream");
  assert.equal(parseProductProfile(" pi-omp "), "pi-omp");
});
