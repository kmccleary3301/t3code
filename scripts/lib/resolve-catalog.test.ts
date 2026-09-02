import { assert, it } from "@effect/vitest";

import { resolveCatalogDependencies, resolveNpmCompatibleOverrides } from "./resolve-catalog.ts";

it("reports unresolved catalog dependencies with lookup context", () => {
  assert.throws(
    () => resolveCatalogDependencies({ effect: "catalog:runtime" }, {}, "apps/server"),
    /Unable to resolve 'catalog:runtime' for apps\/server dependency 'effect'. Expected key 'runtime' in root workspace catalog./,
  );
});

it("drops pnpm-only nested selectors from npm package metadata", () => {
  assert.deepEqual(
    resolveNpmCompatibleOverrides(
      {
        effect: "catalog:",
        "@pierre/diffs>@shikijs/transformers": "^4.2.0",
        "@clerk/clerk-js>@base-org/account": "-",
      },
      { effect: "4.0.0-beta.103" },
      "apps/server",
    ),
    { effect: "4.0.0-beta.103" },
  );
});
