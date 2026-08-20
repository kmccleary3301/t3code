import { assert, it } from "@effect/vitest";

import { parseRuntimeBundleConfig } from "./prepare-runtime-bundles.ts";

it("normalizes and validates pinned runtime bundle metadata", () => {
  const bundles = parseRuntimeBundleConfig(
    JSON.stringify({
      bundles: [
        {
          provider: "pi",
          platform: "darwin",
          arch: "arm64",
          url: "https://downloads.example.test/pi-arm64.tar.gz",
          sha256: "A".repeat(64),
        },
      ],
    }),
  );

  assert.deepStrictEqual(bundles, [
    {
      provider: "pi",
      platform: "darwin",
      arch: "arm64",
      url: "https://downloads.example.test/pi-arm64.tar.gz",
      sha256: "a".repeat(64),
      filename: "pi-runtime-darwin-arm64.tar.gz",
    },
  ]);
});

it("rejects non-HTTPS, duplicate, and partial identity metadata", () => {
  assert.throws(() =>
    parseRuntimeBundleConfig(
      JSON.stringify([
        {
          provider: "pi",
          platform: "darwin",
          arch: "arm64",
          url: "http://downloads.example.test/pi.tar.gz",
          sha256: "a".repeat(64),
        },
      ]),
    ),
  );

  assert.throws(() =>
    parseRuntimeBundleConfig(
      JSON.stringify([
        {
          provider: "omp",
          platform: "linux",
          arch: "x64",
          url: "https://downloads.example.test/omp.tar.gz",
          sha256: "b".repeat(64),
          filename: "omp-runtime-linux-x64.tar.gz",
        },
        {
          provider: "omp",
          platform: "linux",
          arch: "x64",
          url: "https://downloads.example.test/omp-duplicate.tar.gz",
          sha256: "c".repeat(64),
          filename: "omp-runtime-linux-x64.tar.gz",
        },
      ]),
    ),
  );

  assert.throws(() =>
    parseRuntimeBundleConfig(
      JSON.stringify([
        {
          provider: "pi",
          platform: "darwin",
          arch: "arm64",
          url: "https://downloads.example.test/pi.tar.gz",
          sha256: "d".repeat(64),
          filename: "../../pi-runtime-darwin-arm64.tar.gz",
        },
      ]),
    ),
  );
});
