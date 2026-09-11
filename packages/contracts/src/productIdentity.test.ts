import { assert, it } from "@effect/vitest";

import {
  parseProductProfile,
  resolveProductDisplayName,
  resolveProductIdentity,
  resolveProductUpdateRepository,
} from "./productIdentity.ts";

it("keeps the Pi + OMP product installable beside upstream KM Code", () => {
  const upstream = resolveProductIdentity("upstream");
  const piOmp = resolveProductIdentity("pi-omp");

  assert.notEqual(upstream.packageName, piOmp.packageName);
  assert.notEqual(upstream.cliBinaryName, piOmp.cliBinaryName);
  assert.notEqual(upstream.bundleIdentifier, piOmp.bundleIdentifier);
  assert.notEqual(upstream.stateDirectoryName, piOmp.stateDirectoryName);
  assert.notEqual(upstream.productionScheme, piOmp.productionScheme);
  assert.notEqual(upstream.releaseTagPrefix, piOmp.releaseTagPrefix);
  assert.notEqual(upstream.artifactNamePrefix, piOmp.artifactNamePrefix);
  assert.equal(upstream.baseName, "KM Code");
  assert.equal(piOmp.baseName, "KM Code");
  assert.equal(upstream.artifactNamePrefix, "KM-Code");
  assert.equal(piOmp.artifactNamePrefix, "KM-Code-Pi-OMP");
  assert.equal(piOmp.packageName, "t3-pi-omp");
  assert.equal(piOmp.cliBinaryName, "t3-pi-omp");
  assert.equal(piOmp.releaseTagPrefix, "fork-v");
});

it("keeps legacy display names available for state migration", () => {
  assert.equal(resolveProductIdentity("upstream").legacyStableDisplayName, "T3 Code (Alpha)");
  assert.equal(resolveProductIdentity("upstream").legacyDevelopmentDisplayName, "T3 Code (Dev)");
  assert.equal(
    resolveProductIdentity("pi-omp").legacyStableDisplayName,
    "T3 Code Pi + OMP (Alpha)",
  );
  assert.equal(
    resolveProductIdentity("pi-omp").legacyDevelopmentDisplayName,
    "T3 Code Pi + OMP (Dev)",
  );
});

it("formats profile names with the stage qualifier owned by the contract", () => {
  assert.equal(resolveProductDisplayName("upstream", "Local"), "KM Code (Local)");
  assert.equal(resolveProductDisplayName("pi-omp", "Nightly"), "KM Code (Nightly)");
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
