import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
