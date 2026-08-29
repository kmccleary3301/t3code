import {
  ProviderNativeSessionError,
  type ProviderNativeSessionListRequest,
  type ProviderNativeSessionListResult,
  type ProviderNativeSessionOpenInput,
  type ProviderNativeSessionOpenResult,
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
    }),
  },
) {}
