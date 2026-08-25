// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeChildProcess from "node:child_process";

import { assert, it } from "@effect/vitest";

const sanitizer = NodePath.join(
  NodeProcess.cwd(),
  "apps/server/scripts/sanitize-vitest-evidence.mjs",
);
const headSha = "a".repeat(40);

const rawReport = (overrides: Record<string, unknown> = {}) => ({
  numTotalTestSuites: 2,
  numPassedTestSuites: 2,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 4,
  numPassedTests: 4,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  success: true,
  testResults: [
    {
      name: "/Users/private-owner/project/server.test.ts",
      failureMessage: "secret-token-must-never-be-published",
    },
  ],
  ...overrides,
});

it("publishes only aggregate counts and source-head binding", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evidence-"));
  const input = NodePath.join(directory, "raw.json");
  const output = NodePath.join(directory, "safe.json");
  try {
    NodeFS.writeFileSync(input, JSON.stringify(rawReport()));
    NodeChildProcess.execFileSync(NodeProcess.execPath, [
      sanitizer,
      input,
      output,
      "stock-native-root",
      headSha,
    ]);

    assert.equal(NodeFS.existsSync(input), false);
    const serialized = NodeFS.readFileSync(output, "utf8");
    assert.equal(/private-owner|secret-token/.test(serialized), false);
    assert.deepEqual(JSON.parse(serialized), {
      schemaVersion: 1,
      kind: "stock-native-root",
      headSha,
      conclusion: "success",
      counts: {
        numTotalTestSuites: 2,
        numPassedTestSuites: 2,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        numTotalTests: 4,
        numPassedTests: 4,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
      },
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("deletes malformed raw input without publishing an artifact", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-evidence-"));
  const input = NodePath.join(directory, "raw.json");
  const output = NodePath.join(directory, "safe.json");
  try {
    NodeFS.writeFileSync(input, JSON.stringify(rawReport({ numTotalTests: 5 })));
    const result = NodeChildProcess.spawnSync(NodeProcess.execPath, [
      sanitizer,
      input,
      output,
      "stock-native-root",
      headSha,
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(NodeFS.existsSync(input), false);
    assert.equal(NodeFS.existsSync(output), false);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
