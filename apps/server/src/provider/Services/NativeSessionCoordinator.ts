import {
  ProviderNativeSessionError,
  type ProviderNativeSessionArchiveInput,
  type ProviderNativeSessionArchiveResult,
  type ProviderNativeSessionForkInput,
  type ProviderNativeSessionForkResult,
  type ProviderNativeSessionListRequest,
  type ProviderNativeSessionListResult,
  type ProviderNativeSessionOpenInput,
  type ProviderNativeSessionOpenResult,
  type ProviderNativeSessionRenameInput,
  type ProviderNativeSessionRenameResult,
  type ProviderNativeSessionStopInput,
  type ProviderNativeSessionStopResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface NativeSessionCoordinatorShape {
  readonly list: (
    input: ProviderNativeSessionListRequest,
  ) => Effect.Effect<ProviderNativeSessionListResult, ProviderNativeSessionError>;
  readonly open: (
    input: ProviderNativeSessionOpenInput,
  ) => Effect.Effect<ProviderNativeSessionOpenResult, ProviderNativeSessionError>;
  readonly rename: (
    input: ProviderNativeSessionRenameInput,
  ) => Effect.Effect<ProviderNativeSessionRenameResult, ProviderNativeSessionError>;
  readonly fork: (
    input: ProviderNativeSessionForkInput,
  ) => Effect.Effect<ProviderNativeSessionForkResult, ProviderNativeSessionError>;
  readonly stop: (
    input: ProviderNativeSessionStopInput,
  ) => Effect.Effect<ProviderNativeSessionStopResult, ProviderNativeSessionError>;
  readonly archive: (
    input: ProviderNativeSessionArchiveInput,
  ) => Effect.Effect<ProviderNativeSessionArchiveResult, ProviderNativeSessionError>;
}

export class NativeSessionCoordinator extends Context.Reference<NativeSessionCoordinatorShape>(
  "t3/provider/Services/NativeSessionCoordinator",
  {
    defaultValue: () => ({
      list: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Native session coordination is unavailable.",
          }),
        ),
      open: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Native session coordination is unavailable.",
          }),
        ),
      rename: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Native session coordination is unavailable.",
          }),
        ),
      fork: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Native session coordination is unavailable.",
          }),
        ),
      stop: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Native session coordination is unavailable.",
          }),
        ),
      archive: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Native session coordination is unavailable.",
          }),
        ),
    }),
  },
) {}
