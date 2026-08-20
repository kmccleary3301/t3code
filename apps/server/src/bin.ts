import {
  resolveProductIdentity,
  type ProductIdentity,
  type ProductProfile,
} from "@t3tools/contracts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./cli/auth.ts";
import { connectCommand } from "./cli/connect.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { resolveRuntimeProductProfile } from "./cloud/pinnedRuntime.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { runServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { triageCommand } from "./cli/triage.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const selectedProductProfile: ProductProfile = resolveRuntimeProductProfile();
process.env.T3_PRODUCT_PROFILE = selectedProductProfile;

const connectPublicConfigMissingMessage =
  "T3 Connect commands are unavailable: this build is missing T3 Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const makeConnectUnavailableCommand = (identity: ProductIdentity) =>
  Command.make("connect", {
    command: Argument.string("command").pipe(Argument.variadic),
  }).pipe(
    Command.withDescription("T3 Connect is unavailable in builds without public configuration."),
    Command.withHidden,
    Command.withHandler(() =>
      Effect.fail(
        new CliError.ShowHelp({
          commandPath: [identity.cliBinaryName, "connect"],
          errors: [
            new ConnectPublicConfigMissingError({
              cause: connectPublicConfigMissingMessage,
            }),
          ],
        }),
      ),
    ),
  );

export const makeCli = ({
  cloudEnabled = hasCloudPublicConfig,
  profile = selectedProductProfile,
}: {
  readonly cloudEnabled?: boolean;
  readonly profile?: ProductProfile;
} = {}) => {
  const identity = resolveProductIdentity(profile);
  return Command.make(identity.cliBinaryName, { ...sharedServerCommandFlags }).pipe(
    Command.withDescription(`Run the ${identity.baseName} server.`),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([
      startCommand,
      serveCommand,
      pairCommand,
      authCommand,
      projectCommand,
      serviceCommand,
      servicePreflightCommand,
      triageCommand,
      cloudEnabled ? connectCommand : makeConnectUnavailableCommand(identity),
    ]),
  );
};

export const cli = makeCli();

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
