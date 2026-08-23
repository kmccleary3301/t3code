#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export type ChangeClassification = Readonly<{
  readonly files: ReadonlyArray<string>;
  readonly replayGate: boolean;
  readonly budgetGate: boolean;
  readonly distributionGate: boolean;
  readonly docsOnly: boolean;
  readonly publish: boolean;
}>;

const DOCS_ONLY = /^(?:docs\/|\.agents\/|AGENTS\.md$|.*\.md$)/u;
const REPLAY =
  /(?:^|\/)(?:apps\/server\/src\/(?:provider|orchestration|persistence|checkpointing)|apps\/server\/integration|packages\/contracts\/|.*(?:fixture|decoder|projector|projection|transfer|report).*)/u;
const DISTRIBUTION =
  /(?:^|\/)(?:\.github\/workflows\/(?:release|upstream-sync|ci)\.yml|scripts\/(?:install|release|resolve-|prepare-runtime|generate-release|check-upstream|classify-ci)|packages\/contracts\/src\/productIdentity|docs\/(?:user\/install|operations\/release)\.md)/u;

export const classifyFiles = (files: ReadonlyArray<string>): ChangeClassification => {
  const normalized = files.map((file) => file.trim().replaceAll("\\", "/")).filter(Boolean);
  const docsOnly = normalized.length > 0 && normalized.every((file) => DOCS_ONLY.test(file));
  const replayGate = normalized.some((file) => REPLAY.test(file));
  const distributionGate = normalized.some((file) => DISTRIBUTION.test(file));
  return {
    files: normalized,
    replayGate,
    budgetGate: replayGate,
    distributionGate,
    docsOnly,
    publish: !docsOnly && distributionGate,
  };
};

const changedFiles = (): ReadonlyArray<string> => {
  const explicit = process.env.T3_CHANGED_FILES;
  if (explicit !== undefined) return explicit.split("\n");
  const base = process.env.GITHUB_BASE_SHA ?? process.env.T3_CHANGE_BASE;
  const head = process.env.GITHUB_SHA ?? process.env.T3_CHANGE_HEAD ?? "HEAD";
  if (base === undefined) return [];
  return NodeChildProcess.execFileSync("git", ["diff", "--name-only", `${base}..${head}`], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
};

const classification = classifyFiles(changedFiles());
const json = JSON.stringify(classification);
process.stdout.write(`${json}\n`);
const output = process.env.GITHUB_OUTPUT;
if (output !== undefined) {
  NodeFS.appendFileSync(
    output,
    [
      `replay_gate=${classification.replayGate}`,
      `budget_gate=${classification.budgetGate}`,
      `distribution_gate=${classification.distributionGate}`,
      `docs_only=${classification.docsOnly}`,
      `publish=${classification.publish}`,
    ].join("\n") + "\n",
  );
}
