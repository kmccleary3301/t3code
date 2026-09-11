import * as NodeCrypto from "node:crypto";

import {
  ChatImageAttachment,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderNativeSessionError,
  ProviderNativeSessionResumeCursor,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
  type ModelSelection,
  type OrchestrationThread,
  type ProviderNativeSessionArchiveInput,
  type ProviderNativeSessionForkInput,
  type ProviderNativeSessionListRequest,
  type ProviderNativeSessionOpenInput,
  type ProviderNativeSessionRenameInput,
  type ProviderNativeSessionStopInput,
  type ProviderNativeSessionSummary,
  type ProviderSubagentTranscriptReadInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { parseBase64DataUrl } from "../../imageMime.ts";
import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProviderServiceError } from "../Errors.ts";
import * as NativeSessionCoordinator from "../Services/NativeSessionCoordinator.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import type {
  ProviderNativeHistoryMessage,
  ProviderNativeHistoryPage,
  ProviderNativeHistoryTextMessage,
} from "../Services/ProviderAdapter.ts";
import {
  appendNativeHistoryPage,
  NativeHistoryIdentities,
  type ImportedNativeTurn,
} from "./NativeHistoryImport.ts";
import { resolvePiFamilyWorkspacePath } from "../piFamily/NativeSessionCatalog.ts";

const isNativeSessionError = Schema.is(ProviderNativeSessionError);
const isNativeResumeCursor = Schema.is(ProviderNativeSessionResumeCursor);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function asNativeSessionError(cause: unknown): ProviderNativeSessionError {
  if (isNativeSessionError(cause)) return cause;
  return new ProviderNativeSessionError({
    code: "native",
    message: cause instanceof Error ? cause.message : "Native session operation failed",
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
type NativeHistoryImage = NonNullable<ProviderNativeHistoryTextMessage["images"]>[number];

type DecodedNativeImage =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly mimeType: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function decodeNativeHistoryImage(image: NativeHistoryImage): DecodedNativeImage {
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return { ok: false, reason: `unsupported MIME type '${image.mimeType}'` };
  }

  const data = image.data.trim();
  if (data.length === 0) {
    return { ok: false, reason: "empty base64 payload" };
  }
  const dataUrl =
    data.slice(0, 5).toLowerCase() === "data:" ? data : `data:${mimeType};base64,${data}`;
  const parsed = parseBase64DataUrl(dataUrl);
  if (parsed === null) {
    return { ok: false, reason: "invalid base64 data URL" };
  }
  if (parsed.mimeType !== mimeType) {
    return {
      ok: false,
      reason: `MIME type '${parsed.mimeType}' does not match '${mimeType}'`,
    };
  }

  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "empty decoded payload" };
  }
  if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `decoded payload is ${bytes.byteLength} bytes, exceeds the ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES}-byte limit`,
    };
  }
  return { ok: true, bytes, mimeType };
}

function deterministicNativeImageAttachmentId(
  threadId: ThreadId,
  sourceIdentity: string,
  sourceIndex: number,
  imageIndex: number,
): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (threadSegment === null) return null;
  const digest = NodeCrypto.createHash("sha256")
    .update("t3-native-history-image\0")
    .update(String(threadId))
    .update("\0")
    .update(sourceIdentity)
    .update("\0")
    .update(String(sourceIndex))
    .update("\0")
    .update(String(imageIndex))
    .digest("hex");
  const uuid = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
  const attachmentId = `${threadSegment}-${uuid}`;
  return parseThreadSegmentFromAttachmentId(attachmentId) === threadSegment ? attachmentId : null;
}

export const materializeNativeHistoryImages = Effect.fn(
  "NativeSessionCoordinator.materializeNativeHistoryImages",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ProviderNativeHistoryMessage>;
  readonly messageOffset: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const messages: ProviderNativeHistoryMessage[] = [];

  for (const [messageIndex, nativeMessage] of input.messages.entries()) {
    if (nativeMessage.role === "tool" || nativeMessage.images === undefined) {
      messages.push(nativeMessage);
      continue;
    }
    if (nativeMessage.images.length === 0) {
      messages.push(nativeMessage);
      continue;
    }

    const sourceIdentity =
      nativeMessage.sourceId ?? `offset-${input.messageOffset + messageIndex + 1}`;
    const sourceIndex = nativeMessage.sourceIndex ?? input.messageOffset + messageIndex + 1;
    const attachments: ChatImageAttachment[] = [];
    for (const [imageIndex, image] of nativeMessage.images.entries()) {
      const decoded = decodeNativeHistoryImage(image);
      if (!decoded.ok) {
        return yield* new ProviderNativeSessionError({
          code: "invalid",
          message: `Native history image ${sourceIdentity}/${sourceIndex}/${imageIndex} is invalid: ${decoded.reason}.`,
        });
      }
      const attachmentId = deterministicNativeImageAttachmentId(
        input.threadId,
        sourceIdentity,
        sourceIndex,
        imageIndex,
      );
      if (attachmentId === null) {
        return yield* new ProviderNativeSessionError({
          code: "invalid",
          message: `Native history image ${sourceIdentity}/${sourceIndex}/${imageIndex} has no safe attachment id.`,
        });
      }
      const attachment = {
        type: "image" as const,
        id: attachmentId,
        name: `native-image-${messageIndex + 1}-${imageIndex + 1}`,
        mimeType: decoded.mimeType,
        sizeBytes: decoded.bytes.byteLength,
      };
      if (!Schema.is(ChatImageAttachment)(attachment)) {
        return yield* new ProviderNativeSessionError({
          code: "invalid",
          message: `Native history image ${sourceIdentity}/${sourceIndex}/${imageIndex} has invalid attachment metadata.`,
        });
      }
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (attachmentPath === null) {
        return yield* new ProviderNativeSessionError({
          code: "invalid",
          message: `Native history image ${sourceIdentity}/${sourceIndex}/${imageIndex} has no safe attachment path.`,
        });
      }
      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderNativeSessionError({
              code: "native",
              message: `Failed to create storage for native history image ${sourceIdentity}/${sourceIndex}/${imageIndex}.`,
            }),
        ),
      );
      yield* fileSystem.writeFile(attachmentPath, decoded.bytes).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderNativeSessionError({
              code: "native",
              message: `Failed to persist native history image ${sourceIdentity}/${sourceIndex}/${imageIndex}.`,
            }),
        ),
      );
      attachments.push(attachment);
    }
    const { images: _images, ...messageWithoutImages } = nativeMessage;
    messages.push({
      ...messageWithoutImages,
      attachments: [...(nativeMessage.attachments ?? []), ...attachments],
    });
  }
  return messages;
});

function nativeProjectBaseId(workspaceRoot: string): ProjectId {
  const digest = NodeCrypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24);
  return ProjectId.make(`native-project:${digest}`);
}

function nativeThreadBaseId(providerInstanceId: string, sessionId: string): string {
  return `native:${providerInstanceId}:${sessionId}`;
}

export function nativeThreadHasActiveTurn(
  thread:
    | {
        readonly session: {
          readonly status: string;
          readonly activeTurnId: unknown;
        } | null;
      }
    | undefined,
): boolean {
  return thread?.session?.status === "running" && thread.session.activeTurnId != null;
}

function chooseModelSelection(
  summary: ProviderNativeSessionSummary,
  projectDefault: ModelSelection | null,
  providerModels: ReadonlyArray<{ readonly slug: string }>,
): ModelSelection | undefined {
  const summaryModel =
    summary.model === undefined
      ? undefined
      : (providerModels.find(
          ({ slug }) => slug === summary.model || slug.endsWith(`/${summary.model}`),
        )?.slug ?? summary.model);
  const model =
    summaryModel ??
    (projectDefault?.instanceId === summary.providerInstanceId
      ? projectDefault.model
      : undefined) ??
    providerModels[0]?.slug;
  return model === undefined ? undefined : { instanceId: summary.providerInstanceId, model };
}

const makeNativeSessionCoordinator = Effect.gen(function* () {
  const providerService = yield* ProviderService.ProviderService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turnRepository = yield* ProjectionTurnRepository;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const openSemaphore = yield* Semaphore.make(1);

  const listInternal = Effect.fn("NativeSessionCoordinator.listInternal")(function* (
    input: ProviderNativeSessionListRequest,
  ) {
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find(
      (candidate) => candidate.instanceId === input.providerInstanceId,
    );
    if (
      provider === undefined ||
      (provider.driver !== "pi" && provider.driver !== "omp") ||
      !provider.enabled ||
      !provider.installed
    ) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: `Provider '${input.providerInstanceId}' is not an available Pi-family instance.`,
      });
    }
    const listNativeSessions = providerService.listNativeSessions;
    if (listNativeSessions === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: "This server has no native session catalog.",
      });
    }
    return {
      sessions: yield* listNativeSessions({
        providerInstanceId: input.providerInstanceId,
      }),
    };
  });

  const importHistory = Effect.fn("NativeSessionCoordinator.importHistory")(function* (
    threadId: ThreadId,
    readPage: (cursor?: string) => Effect.Effect<ProviderNativeHistoryPage, ProviderServiceError>,
  ) {
    const existingThread = Option.getOrUndefined(yield* snapshots.getThreadDetailById(threadId));
    const existingTurns = yield* turnRepository.listByThreadId({ threadId });
    const identities = new NativeHistoryIdentities({
      threadId,
      messages: existingThread?.messages ?? [],
      activities: existingThread?.activities ?? [],
      turns: existingTurns.flatMap((turn): ImportedNativeTurn[] =>
        turn.turnId === null || turn.state === "pending"
          ? []
          : [
              {
                turnId: turn.turnId,
                state: turn.state,
                requestedAt: turn.requestedAt,
                startedAt: turn.startedAt,
                completedAt: turn.completedAt,
                assistantMessageId: turn.assistantMessageId,
              },
            ],
      ),
    });
    let cursor: string | undefined;
    let messageOffset = 0;
    let turnOffset = 0;
    let currentTurn: ImportedNativeTurn | null = null;
    let totalMessages = 0;
    do {
      const page = yield* readPage(cursor);
      totalMessages = page.totalMessages;
      const materializedMessages = yield* materializeNativeHistoryImages({
        threadId,
        messages: page.messages,
        messageOffset,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      );
      const imported = appendNativeHistoryPage({
        threadId,
        messages: materializedMessages,
        messageOffset,
        turnOffset,
        currentTurn,
        identities,
      });
      messageOffset = imported.messageOffset;
      turnOffset = imported.turnOffset;
      currentTurn = imported.currentTurn;
      const importedAt = DateTime.formatIso(yield* DateTime.now);
      const importDigest = NodeCrypto.createHash("sha256")
        .update(encodeJson({ messages: imported.messages, turns: imported.turns }))
        .digest("hex");
      yield* engine.dispatch({
        type: "thread.native-history.import",
        commandId: CommandId.make(`native-history-source:${threadId}:${importDigest}`),
        threadId,
        messages: imported.messages,
        turns: imported.turns,
        importedAt,
      });
      for (const activity of imported.activities) {
        const activityDigest = NodeCrypto.createHash("sha256")
          .update(encodeJson(activity))
          .digest("hex");
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`native-history-tool:${activity.id}:${activityDigest}`),
          threadId,
          activity,
          createdAt: activity.createdAt,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return totalMessages;
  });

  const openInternal = Effect.fn("NativeSessionCoordinator.openInternal")(function* (
    input: ProviderNativeSessionOpenInput,
  ) {
    const listed = yield* listInternal({ providerInstanceId: input.providerInstanceId });
    const summary = listed.sessions.find((session) => session.sessionId === input.sessionId);
    if (summary === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "not_found",
        message: `Native session '${input.sessionId}' was not found.`,
      });
    }

    let workspaceRoot = path.resolve(summary.cwd);
    let readModel = yield* snapshots.getCommandReadModel();
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find(
      (candidate) => candidate.instanceId === input.providerInstanceId,
    );
    if (provider === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "not_found",
        message: `Provider instance '${input.providerInstanceId}' was not found.`,
      });
    }
    const bindings = yield* directory.listBindings();
    const existingBinding = bindings.find(
      (binding) =>
        binding.providerInstanceId === input.providerInstanceId &&
        isNativeResumeCursor(binding.resumeCursor) &&
        binding.resumeCursor.runtime === summary.runtime &&
        binding.resumeCursor.sessionId === input.sessionId,
    );
    const boundThread =
      existingBinding === undefined
        ? undefined
        : readModel.threads.find(
            (thread) => thread.id === existingBinding.threadId && thread.deletedAt === null,
          );
    const boundProject =
      boundThread === undefined
        ? undefined
        : readModel.projects.find(
            (candidate) => candidate.id === boundThread.projectId && candidate.deletedAt === null,
          );
    let existingProject =
      boundProject ??
      Option.getOrUndefined(yield* snapshots.getActiveProjectByWorkspaceRoot(workspaceRoot));
    if (existingProject === undefined) {
      existingProject = yield* Effect.tryPromise({
        try: async () => {
          const canonicalWorkspace = await resolvePiFamilyWorkspacePath(workspaceRoot);
          for (const candidate of readModel.projects) {
            if (candidate.deletedAt !== null) continue;
            if (
              (await resolvePiFamilyWorkspacePath(path.resolve(candidate.workspaceRoot))) ===
              canonicalWorkspace
            ) {
              return candidate;
            }
          }
          return undefined;
        },
        catch: (cause) =>
          new ProviderNativeSessionError({
            code: "native",
            message: `Could not resolve native workspace paths: ${String(cause)}`,
          }),
      });
      if (existingProject !== undefined) workspaceRoot = existingProject.workspaceRoot;
    }
    const provisionalModelSelection = chooseModelSelection(
      summary,
      existingProject?.defaultModelSelection ?? null,
      provider?.models ?? [],
    );
    if (provisionalModelSelection === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: `Native session '${input.sessionId}' has no recoverable model.`,
      });
    }

    let project = existingProject;
    if (project === undefined) {
      const baseProjectId = nativeProjectBaseId(workspaceRoot);
      const collided = readModel.projects.some((candidate) => candidate.id === baseProjectId);
      const projectId = collided
        ? ProjectId.make(`${baseProjectId}:${DateTime.toEpochMillis(yield* DateTime.now)}`)
        : baseProjectId;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`native-project-create:${projectId}`),
        projectId,
        title: path.basename(workspaceRoot) || "project",
        workspaceRoot,
        defaultModelSelection: provisionalModelSelection,
        createdAt,
      });
      readModel = yield* snapshots.getCommandReadModel();
      project = readModel.projects.find(
        (candidate) => candidate.id === projectId && candidate.deletedAt === null,
      );
      if (project === undefined) {
        return yield* new ProviderNativeSessionError({
          code: "native",
          message: `Native session project '${projectId}' was not created.`,
        });
      }
    }

    const modelSelection = chooseModelSelection(
      summary,
      project.defaultModelSelection,
      provider?.models ?? [],
    );
    if (modelSelection === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: `Native session '${input.sessionId}' has no recoverable model.`,
      });
    }

    const baseThreadId = ThreadId.make(
      nativeThreadBaseId(input.providerInstanceId, input.sessionId),
    );
    const deterministicThread = readModel.threads.find(
      (thread) => thread.id === baseThreadId && thread.deletedAt === null,
    );
    let thread: Pick<OrchestrationThread, "id" | "modelSelection" | "archivedAt"> | undefined =
      boundThread ?? deterministicThread;

    if (thread === undefined) {
      const collided = readModel.threads.some((candidate) => candidate.id === baseThreadId);
      const threadId = collided
        ? ThreadId.make(`${baseThreadId}:${DateTime.toEpochMillis(yield* DateTime.now)}`)
        : baseThreadId;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`native-thread-create:${threadId}`),
        threadId,
        projectId: project.id,
        title: summary.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: summary.createdAt,
      });
      thread = { id: threadId, modelSelection, archivedAt: null };
    } else if (thread.archivedAt !== null) {
      yield* engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make(`native-thread-unarchive:${thread.id}`),
        threadId: thread.id,
      });
    }

    const threadId = thread.id;
    const activeSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === threadId,
    );
    if (
      activeSession !== undefined &&
      (activeSession.providerInstanceId !== input.providerInstanceId ||
        !isNativeResumeCursor(activeSession.resumeCursor) ||
        activeSession.resumeCursor.runtime !== summary.runtime ||
        activeSession.resumeCursor.sessionId !== input.sessionId)
    ) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: `Thread '${threadId}' is already bound to a different provider session.`,
      });
    }
    if (activeSession !== undefined) {
      const activeThread = Option.getOrUndefined(yield* snapshots.getThreadDetailById(threadId));
      if (activeThread !== undefined && nativeThreadHasActiveTurn(activeThread)) {
        return { projectId: project.id, threadId };
      }
      yield* syncThreadInternal(threadId);
      return { projectId: project.id, threadId };
    }
    if (input.indexOnly === true) {
      const readNativeHistoryBySession = providerService.readNativeHistoryBySession;
      if (readNativeHistoryBySession === undefined) {
        return yield* new ProviderNativeSessionError({
          code: "unsupported",
          message: "This server has no offline native history reader.",
        });
      }
      const nativeHistoryMessageCount = yield* importHistory(threadId, (cursor) =>
        readNativeHistoryBySession({
          providerInstanceId: input.providerInstanceId,
          sessionId: input.sessionId,
          cwd: workspaceRoot,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      const currentBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (currentBinding === undefined) {
        yield* directory.upsert({
          threadId,
          provider: provider.driver,
          providerInstanceId: input.providerInstanceId,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor: {
            kind: "native-session",
            runtime: summary.runtime,
            sessionId: input.sessionId,
          },
          runtimePayload: {
            cwd: workspaceRoot,
            model: modelSelection.model,
            activeTurnId: null,
            lastError: null,
            modelSelection,
            nativeHistoryMessageCount,
          },
        });
      } else {
        const runtimePayload = asRecord(currentBinding.runtimePayload);
        yield* directory.upsert({
          ...currentBinding,
          runtimePayload: { ...runtimePayload, nativeHistoryMessageCount },
        });
      }
      return { projectId: project.id, threadId };
    }
    const session =
      activeSession ??
      (yield* providerService.startSession(threadId, {
        threadId,
        providerInstanceId: input.providerInstanceId,
        cwd: workspaceRoot,
        title: summary.title,
        modelSelection,
        resumeCursor: {
          kind: "native-session",
          runtime: summary.runtime,
          sessionId: input.sessionId,
        },
        runtimeMode: "full-access",
      }));

    if (session.model !== undefined && session.model !== thread.modelSelection.model) {
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`native-thread-model:${threadId}:${session.model}`),
        threadId,
        modelSelection: { instanceId: input.providerInstanceId, model: session.model },
      });
    }

    const readNativeHistory = providerService.readNativeHistory;
    if (readNativeHistory === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: "This server has no native history reader.",
      });
    }
    const nativeHistoryMessageCount = yield* importHistory(threadId, (cursor) =>
      readNativeHistory({
        threadId,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const currentBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    if (currentBinding !== undefined) {
      const runtimePayload = asRecord(currentBinding.runtimePayload);
      yield* directory.upsert({
        ...currentBinding,
        runtimePayload: { ...runtimePayload, nativeHistoryMessageCount },
      });
    }
    return { projectId: project.id, threadId };
  });
  const findBoundThread = Effect.fn("NativeSessionCoordinator.findBoundThread")(function* (input: {
    readonly providerInstanceId: string;
    readonly sessionId: string;
  }) {
    const bindings = yield* directory.listBindings();
    return bindings.find(
      (binding) =>
        binding.providerInstanceId === input.providerInstanceId &&
        isNativeResumeCursor(binding.resumeCursor) &&
        binding.resumeCursor.sessionId === input.sessionId,
    )?.threadId;
  });
  const syncThreadInternal = Effect.fn("NativeSessionCoordinator.syncThreadInternal")(function* (
    threadId: ThreadId,
  ) {
    const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    let providerInstanceId: string | undefined = binding?.providerInstanceId;
    let sessionId: string | undefined =
      binding !== undefined && isNativeResumeCursor(binding.resumeCursor)
        ? binding.resumeCursor.sessionId
        : undefined;

    if (providerInstanceId === undefined || sessionId === undefined) {
      const match = /^native:([^:]+):(.+)$/.exec(threadId);
      if (match && match[1] && match[2]) {
        providerInstanceId = match[1];
        sessionId = match[2];
      }
    }

    if (providerInstanceId === undefined || sessionId === undefined) {
      return { synced: false };
    }

    const readNativeHistoryBySession = providerService.readNativeHistoryBySession;
    if (readNativeHistoryBySession === undefined) {
      return { synced: false };
    }

    const commandReadModel = yield* snapshots.getCommandReadModel();
    const thread = commandReadModel.threads.find((t) => t.id === threadId);
    let workspaceRoot = (binding?.runtimePayload as Record<string, unknown> | undefined)?.cwd as
      | string
      | undefined;
    if (workspaceRoot === undefined && thread !== undefined) {
      const project = commandReadModel.projects.find((p) => p.id === thread.projectId);
      if (project !== undefined) {
        workspaceRoot = project.workspaceRoot;
      }
    }
    if (workspaceRoot === undefined) {
      workspaceRoot = serverConfig.cwd;
    }

    const nativeHistoryMessageCount = yield* importHistory(threadId, (cursor) =>
      readNativeHistoryBySession({
        providerInstanceId: ProviderInstanceId.make(providerInstanceId!),
        sessionId: sessionId!,
        cwd: workspaceRoot!,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));

    if (nativeHistoryMessageCount === undefined) {
      return { synced: false };
    }

    const currentBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
    if (currentBinding !== undefined) {
      const runtimePayload = asRecord(currentBinding.runtimePayload);
      yield* directory.upsert({
        ...currentBinding,
        runtimePayload: { ...runtimePayload, nativeHistoryMessageCount },
      });
    }

    return { synced: true, messageCount: nativeHistoryMessageCount };
  });

  const renameInternal = Effect.fn("NativeSessionCoordinator.renameInternal")(function* (
    input: ProviderNativeSessionRenameInput,
  ) {
    const renameNativeSession = providerService.renameNativeSession;
    if (renameNativeSession === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: "This server cannot rename native sessions.",
      });
    }
    const opened = yield* openInternal(input);
    yield* renameNativeSession({ threadId: opened.threadId, name: input.name });
    const nameDigest = NodeCrypto.createHash("sha256")
      .update(input.name)
      .digest("hex")
      .slice(0, 16);
    yield* engine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make(`native-thread-rename:${opened.threadId}:${nameDigest}`),
      threadId: opened.threadId,
      title: input.name,
    });
    return { sessionId: input.sessionId, title: input.name };
  });

  const forkInternal = Effect.fn("NativeSessionCoordinator.forkInternal")(function* (
    input: ProviderNativeSessionForkInput,
  ) {
    const forkNativeSession = providerService.forkNativeSession;
    if (forkNativeSession === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: "This server cannot fork native sessions.",
      });
    }
    const source = yield* openInternal(input);
    const forked = yield* forkNativeSession({ threadId: source.threadId });
    yield* providerService.stopSession({ threadId: source.threadId });
    const opened = yield* openInternal({
      providerInstanceId: input.providerInstanceId,
      sessionId: forked.sessionId,
    });
    return { sessionId: forked.sessionId, ...opened };
  });

  const stopInternal = Effect.fn("NativeSessionCoordinator.stopInternal")(function* (
    input: ProviderNativeSessionStopInput,
  ) {
    const threadId = yield* findBoundThread(input);
    if (threadId === undefined) return {};
    yield* providerService.stopSession({ threadId });
    return { threadId };
  });

  const archiveInternal = Effect.fn("NativeSessionCoordinator.archiveInternal")(function* (
    input: ProviderNativeSessionArchiveInput,
  ) {
    const opened = yield* openInternal(input);
    const currentThread = (yield* snapshots.getCommandReadModel()).threads.find(
      (thread) => thread.id === opened.threadId && thread.deletedAt === null,
    );
    if (nativeThreadHasActiveTurn(currentThread)) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: "This native session is working. Interrupt it before archiving the thread.",
      });
    }
    yield* providerService.stopSession({ threadId: opened.threadId });
    yield* engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`native-thread-archive:${opened.threadId}`),
      threadId: opened.threadId,
    });
    return { threadId: opened.threadId };
  });

  const readSubagentTranscript = Effect.fn("NativeSessionCoordinator.readSubagentTranscript")(
    function* (input: ProviderSubagentTranscriptReadInput) {
      const readTranscript = providerService.readSubagentTranscript;
      if (readTranscript === undefined) {
        return yield* new ProviderNativeSessionError({
          code: "unsupported",
          message: "This server has no subagent transcript reader.",
        });
      }
      return yield* readTranscript({
        threadId: input.threadId,
        subagentId: input.subagentId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
    },
  );

  return {
    list: (input) => listInternal(input).pipe(Effect.mapError(asNativeSessionError)),
    open: (input) =>
      openSemaphore.withPermits(1)(openInternal(input)).pipe(Effect.mapError(asNativeSessionError)),
    syncThread: (threadId) =>
      openSemaphore
        .withPermits(1)(syncThreadInternal(threadId))
        .pipe(Effect.mapError(asNativeSessionError)),
    rename: (input) =>
      openSemaphore
        .withPermits(1)(renameInternal(input))
        .pipe(Effect.mapError(asNativeSessionError)),
    fork: (input) =>
      openSemaphore.withPermits(1)(forkInternal(input)).pipe(Effect.mapError(asNativeSessionError)),
    stop: (input) =>
      openSemaphore.withPermits(1)(stopInternal(input)).pipe(Effect.mapError(asNativeSessionError)),
    archive: (input) =>
      openSemaphore
        .withPermits(1)(archiveInternal(input))
        .pipe(Effect.mapError(asNativeSessionError)),
    readSubagentTranscript: (input) =>
      readSubagentTranscript(input).pipe(Effect.mapError(asNativeSessionError)),
  } satisfies NativeSessionCoordinator.NativeSessionCoordinatorShape;
});

export const NativeSessionCoordinatorLive = Layer.effect(
  NativeSessionCoordinator.NativeSessionCoordinator,
  makeNativeSessionCoordinator,
);
