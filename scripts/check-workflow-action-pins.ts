#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const workflowDir = NodePath.join(root, ".github", "workflows");
const shaPattern = /^[0-9a-f]{40}$/u;
const failures: string[] = [];

for (const fileName of NodeFS.readdirSync(workflowDir).filter((name) => name.endsWith(".yml"))) {
  const filePath = NodePath.join(workflowDir, fileName);
  const source = NodeFS.readFileSync(filePath, "utf8");
  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/^\s*uses:\s*([^\s#]+)\s*(?:#\s*(.*))?$/u);
    if (match === null) continue;
    const reference = match[1];
    if (reference === undefined || reference.startsWith("./")) continue;
    const sha = reference.slice(reference.lastIndexOf("@") + 1);
    const comment = match[2]?.trim();
    if (!shaPattern.test(sha))
      failures.push(`${fileName}:${index + 1}: action is not pinned to a commit SHA`);
    if (comment === undefined || comment.length === 0)
      failures.push(`${fileName}:${index + 1}: pinned action needs a version/revision comment`);
  }
}

const threadPublisher = NodeFS.readFileSync(
  NodePath.join(workflowDir, "thread-transfer-report.yml"),
  "utf8",
);
if (!threadPublisher.includes("ref: ${{ github.event.repository.default_branch }}")) {
  failures.push("thread-transfer-report.yml: publisher must checkout the trusted default branch");
}
if (threadPublisher.includes("github.event.pull_request.head.sha")) {
  failures.push("thread-transfer-report.yml: publisher must not checkout a pull-request head");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Workflow action pins and trusted publisher checks passed.\n");
