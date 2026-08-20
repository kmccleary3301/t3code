import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ServerConfig } from "../../config.ts";

import { makePiFamilyDriver } from "./PiFamilyDriver.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export const OmpDriver = makePiFamilyDriver({
  provider: ProviderDriverKind.make("omp"),
  displayName: "Oh My Pi",
  configSchema: OmpSettings,
  defaultConfig: () => decodeOmpSettings({}),
});

export type OmpDriverEnv = ServerConfig;
