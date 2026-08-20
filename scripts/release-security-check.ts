#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const root = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = NodeFS.readFileSync(NodePath.join(root, ".github/workflows/release.yml"), "utf8");
const upstreamSyncWorkflow = NodeFS.readFileSync(
  NodePath.join(root, ".github/workflows/upstream-sync.yml"),
  "utf8",
);
const installer = NodeFS.readFileSync(NodePath.join(root, "scripts/install.sh"), "utf8");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// Keep distribution configuration explicit. In particular, a fork must never
// inherit an update repository from the upstream product by accident.
assert(
  workflow.includes("T3_PI_OMP_RELEASE_REPOSITORY"),
  "Fork release repository variable is not exposed.",
);
assert(
  workflow.includes("T3CODE_DESKTOP_UPDATE_REPOSITORY"),
  "Desktop updater repository variable is not exposed.",
);
assert(
  workflow.includes("release-assets/RELEASE-MANIFEST.json"),
  "Release manifest is not published.",
);
assert(workflow.includes("release-assets/SHA256SUMS"), "Release checksum index is not published.");
assert(
  upstreamSyncWorkflow.includes("check-upstream-sync.ts"),
  "Upstream sync automation is not present.",
);
assert(
  workflow.includes("actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be"),
  "Build provenance attestation must remain enabled and pinned.",
);
assert(
  workflow.includes("T3_PI_OMP_RUNTIME_BUNDLES_JSON"),
  "Runtime bundle configuration is not exposed.",
);
assert(
  workflow.includes("scripts/prepare-runtime-bundles.ts"),
  "Runtime bundle verifier is not wired.",
);
assert(
  workflow.includes("needs.prepare_runtime_bundles.outputs.has_assets"),
  "Runtime bundle publication is not gated.",
);
assert(installer.includes("--install-runtimes"), "Installer runtime opt-in is missing.");

// Reject the two most common unsafe installer regressions without requiring
// network-backed scanners on local smoke runs.
assert(
  !/\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/u.test(installer),
  "Installer must not pipe curl directly into a shell.",
);
assert(
  !/\bwget\b[^\n|]*\|\s*(?:ba)?sh\b/u.test(installer),
  "Installer must not pipe wget directly into a shell.",
);
assert(/set -eu(?:o pipefail)?\b/u.test(installer), "Installer must use strict shell options.");

process.stdout.write("Release security checks passed.\n");
