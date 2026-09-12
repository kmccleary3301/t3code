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
  type ProviderSubagentTranscriptReadInput,
  type ProviderSubagentTranscriptReadResult,
  type ThreadId,
} from "@t3tools/contracts";

export interface ProviderNativeSessionSyncResult {
  readonly synced: boolean;
  readonly messageCount?: number;
}
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface NativeSessionCoordinatorShape {
  readonly list: (
    input: ProviderNativeSessionListRequest,
  ) => Effect.Effect<ProviderNativeSessionListResult, ProviderNativeSessionError>;
  readonly open: (
    input: ProviderNativeSessionOpenInput,
  ) => Effect.Effect<ProviderNativeSessionOpenResult, ProviderNativeSessionError>;
  readonly syncThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderNativeSessionSyncResult, ProviderNativeSessionError>;
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
  readonly readSubagentTranscript: (
    input: ProviderSubagentTranscriptReadInput,
  ) => Effect.Effect<ProviderSubagentTranscriptReadResult, ProviderNativeSessionError>;
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
      syncThread: () => Effect.succeed({ synced: false }),
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
      readSubagentTranscript: () =>
        Effect.fail(
          new ProviderNativeSessionError({
            code: "unsupported",
            message: "Subagent transcripts are unavailable.",
          }),
        ),
    }),
  },
) {}
