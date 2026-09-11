import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { appendNativeHistoryPage } from "./NativeHistoryImport.ts";
import {
  materializeNativeHistoryImages,
  nativeThreadHasActiveTurn,
} from "./NativeSessionCoordinator.ts";
import { NativeSessionCoordinatorLive } from "./NativeSessionCoordinator.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as NativeSessionCoordinator from "../Services/NativeSessionCoordinator.ts";

const nativeImageTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-native-history-image-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const nativeImageMessage = {
  role: "user" as const,
  text: "",
  timestamp: "2026-09-08T12:00:00.000Z",
  sourceId: "native-source-1",
  sourceIndex: 2,
  images: [
    {
      type: "image" as const,
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    },
  ],
};

it.effect("persists native image bytes and preserves image-only messages", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("native-image-thread");
    const materialized = yield* materializeNativeHistoryImages({
      threadId,
      messages: [nativeImageMessage],
      messageOffset: 0,
    });
    const imported = appendNativeHistoryPage({
      threadId,
      messages: materialized,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    });
    const message = imported.messages[0];
    expect(message?.role).toBe("user");
    expect(message?.text).toBe("");
    const attachment = message?.attachments?.[0];
    expect(attachment).toMatchObject({
      type: "image",
      mimeType: "image/png",
      sizeBytes: 8,
    });
    if (attachment === undefined) return;
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    expect(attachmentPath).not.toBeNull();
    if (attachmentPath === null) return;
    expect(Array.from(yield* fileSystem.readFile(attachmentPath))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(yield* fileSystem.readDirectory(config.attachmentsDir)).toEqual([
      path.basename(attachmentPath),
    ]);
  }).pipe(Effect.provide(nativeImageTestLayer)),
);

it.effect("reuses deterministic native image attachment identity on repeat import", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const threadId = ThreadId.make("native-image-repeat-thread");
    const first = yield* materializeNativeHistoryImages({
      threadId,
      messages: [nativeImageMessage],
      messageOffset: 0,
    });
    const second = yield* materializeNativeHistoryImages({
      threadId,
      messages: [nativeImageMessage],
      messageOffset: 0,
    });
    const firstImport = appendNativeHistoryPage({
      threadId,
      messages: first,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    });
    const secondImport = appendNativeHistoryPage({
      threadId,
      messages: second,
      messageOffset: 0,
      turnOffset: 0,
      currentTurn: null,
    });
    const firstAttachment = firstImport.messages[0]?.attachments?.[0];
    const secondAttachment = secondImport.messages[0]?.attachments?.[0];
    expect(firstAttachment?.id).toBe(secondAttachment?.id);
    expect(yield* fileSystem.readDirectory(config.attachmentsDir)).toHaveLength(1);
  }).pipe(Effect.provide(nativeImageTestLayer)),
);

it.effect("reports invalid native image data instead of dropping it", () =>
  Effect.gen(function* () {
    const error = yield* materializeNativeHistoryImages({
      threadId: ThreadId.make("native-image-invalid-thread"),
      messages: [
        {
          ...nativeImageMessage,
          images: [{ type: "image" as const, data: "not-base64", mimeType: "image/png" }],
        },
      ],
      messageOffset: 0,
    }).pipe(Effect.flip);
    expect(error.code).toBe("invalid");
    expect(error.message).toContain("invalid");
  }).pipe(Effect.provide(nativeImageTestLayer)),
);

describe("nativeThreadHasActiveTurn", () => {
  it("blocks archive while a native turn is running", () => {
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "running", activeTurnId: "turn-1" },
      }),
    ).toBe(true);
  });

  it("allows archive when no turn is active", () => {
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "running", activeTurnId: null },
      }),
    ).toBe(false);
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "ready", activeTurnId: "stale-turn" },
      }),
    ).toBe(false);
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "running", activeTurnId: undefined },
      }),
    ).toBe(false);
    expect(nativeThreadHasActiveTurn({ session: null })).toBe(false);
    expect(nativeThreadHasActiveTurn(undefined)).toBe(false);
  });
});

describe("NativeSessionCoordinator syncThread", () => {
  it.effect("defaults to unsynced for unbound or uncoordinated threads", () =>
    Effect.gen(function* () {
      const coordinator = NativeSessionCoordinator.NativeSessionCoordinator.defaultValue();
      const result = yield* coordinator.syncThread(ThreadId.make("thread-1"));
      expect(result).toEqual({ synced: false });
    }),
  );

  it.effect("syncs bound native session threads and imports history", () =>
    Effect.gen(function* () {
      const dispatchedCommands: any[] = [];
      const mockProviderService = Layer.succeed(ProviderService.ProviderService, {
        readNativeHistoryBySession: vi.fn(({ sessionId }: { sessionId: string }) =>
          Effect.succeed({
            messages: [
              {
                role: "user" as const,
                text: `synced message for ${sessionId}`,
                timestamp: "2026-09-11T12:00:00.000Z",
              },
            ],
            totalMessages: 1,
          }),
        ),
      } as unknown as ProviderService.ProviderServiceShape);
      const mockProviderRegistry = Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape);
      const mockDirectory = Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
        getBinding: vi.fn((threadId: ThreadId) =>
          threadId === "native:omp:session-1"
            ? Effect.succeed(
                Option.some({
                  threadId,
                  provider: ProviderDriverKind.make("omp"),
                  providerInstanceId: ProviderInstanceId.make("omp"),
                  runtimeMode: "full-access" as const,
                  status: "stopped" as const,
                  resumeCursor: {
                    kind: "native-session" as const,
                    runtime: "omp" as const,
                    sessionId: "session-1",
                  },
                  runtimePayload: { cwd: "/workspace" },
                }),
              )
            : Effect.succeed(Option.none()),
        ),
        upsert: vi.fn(() => Effect.void),
        listBindings: vi.fn(() => Effect.succeed([])),
      } as unknown as ProviderSessionDirectory.ProviderSessionDirectoryShape);
      const mockSnapshots = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: [], projects: [] }),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape);
      const mockTurnRepo = Layer.succeed(ProjectionTurnRepository, {
        listByThreadId: () => Effect.succeed([]),
      } as unknown as any);
      const mockEngine = Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: vi.fn((cmd: any) => {
          dispatchedCommands.push(cmd);
          return Effect.void;
        }),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape);

      const testLayer = NativeSessionCoordinatorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            mockProviderService,
            mockProviderRegistry,
            mockDirectory,
            mockSnapshots,
            mockTurnRepo,
            mockEngine,
            nativeImageTestLayer,
          ),
        ),
      );
      const coordinator = yield* NativeSessionCoordinator.NativeSessionCoordinator.pipe(
        Effect.provide(testLayer),
      );
      const nonNative = yield* coordinator.syncThread(ThreadId.make("thread-regular"));
      expect(nonNative).toEqual({ synced: false });

      const nativeSync = yield* coordinator.syncThread(ThreadId.make("native:omp:session-1"));
      expect(nativeSync).toEqual({ synced: true, messageCount: 1 });
      expect(dispatchedCommands.some((c) => c.type === "thread.native-history.import")).toBe(true);

      const unboundNativeSync = yield* coordinator.syncThread(
        ThreadId.make("native:omp:session-2"),
      );
      expect(unboundNativeSync).toEqual({ synced: true, messageCount: 1 });
    }),
  );
});
