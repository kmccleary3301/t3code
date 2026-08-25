import { readFile, unlink, writeFile } from "node:fs/promises";

const [inputPath, outputPath, kind, headSha] = process.argv.slice(2);

if (!inputPath || !outputPath || !kind || !headSha) {
  throw new Error("usage: sanitize-vitest-evidence <input> <output> <kind> <head-sha>");
}
if (!/^[a-z0-9-]+$/.test(kind)) throw new Error("invalid evidence kind");
if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("invalid evidence head SHA");

const countKeys = [
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "numPendingTestSuites",
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
];

try {
  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const counts = Object.fromEntries(
    countKeys.map((key) => {
      const value = raw[key];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid Vitest aggregate ${key}`);
      }
      return [key, value];
    }),
  );
  if (
    counts.numTotalTestSuites !==
    counts.numPassedTestSuites + counts.numFailedTestSuites + counts.numPendingTestSuites
  ) {
    throw new Error("inconsistent Vitest suite aggregates");
  }
  if (
    counts.numTotalTests !==
    counts.numPassedTests + counts.numFailedTests + counts.numPendingTests + counts.numTodoTests
  ) {
    throw new Error("inconsistent Vitest test aggregates");
  }

  const conclusion =
    raw.success === true && counts.numFailedTestSuites === 0 && counts.numFailedTests === 0
      ? "success"
      : "failure";
  const evidence = {
    schemaVersion: 1,
    kind,
    headSha,
    conclusion,
    counts,
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
} finally {
  await unlink(inputPath).catch(() => undefined);
}
