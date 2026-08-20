#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

const remote = flag("--remote");
const ref = flag("--ref");
const remoteRef = `refs/remotes/${remote}/${ref}`;
try {
  NodeChildProcess.execFileSync("git", ["show-ref", "--verify", "--quiet", remoteRef], {
    stdio: "ignore",
  });
  NodeChildProcess.execFileSync("git", ["merge-base", "--is-ancestor", remoteRef, "HEAD"], {
    stdio: "ignore",
  });
  process.stdout.write(`Upstream sync check passed: HEAD contains ${remoteRef}.\n`);
} catch {
  process.stderr.write(
    `Upstream sync check failed: HEAD does not contain ${remoteRef}. Configure the explicit owner-controlled remote/ref before releasing.\n`,
  );
  process.exitCode = 1;
}
