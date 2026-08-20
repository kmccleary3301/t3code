import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ServerConfig } from "../../config.ts";

import { makePiFamilyDriver } from "./PiFamilyDriver.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

export const PiDriver = makePiFamilyDriver({
  provider: ProviderDriverKind.make("pi"),
  displayName: "Pi",
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
});

export type PiDriverEnv = ServerConfig;
