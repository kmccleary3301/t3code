import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ProjectId,
  ProviderNativeSessionError,
  ProviderNativeSessionResumeCursor,
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
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceError } from "../Errors.ts";
import * as NativeSessionCoordinator from "../Services/NativeSessionCoordinator.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import type { ProviderNativeHistoryPage } from "../Services/ProviderAdapter.ts";
import { appendNativeHistoryPage, type ImportedNativeTurn } from "./NativeHistoryImport.ts";

const isNativeSessionError = Schema.is(ProviderNativeSessionError);
const isNativeResumeCursor = Schema.is(ProviderNativeSessionResumeCursor);

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
        )?.slug ?? (providerModels.length === 0 ? summary.model : undefined));
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
  const path = yield* Path.Path;
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
    let cursor: string | undefined;
    let pageIndex = 0;
    let messageOffset = 0;
    let turnOffset = 0;
    let currentTurn: ImportedNativeTurn | null = null;
    let totalMessages = 0;
    do {
      const page = yield* readPage(cursor);
      totalMessages = page.totalMessages;
      const imported = appendNativeHistoryPage({
        threadId,
        messages: page.messages,
        messageOffset,
        turnOffset,
        currentTurn,
      });
      messageOffset = imported.messageOffset;
      turnOffset = imported.turnOffset;
      currentTurn = imported.currentTurn;
      const importedAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.native-history.import",
        commandId: CommandId.make(`native-history:${threadId}:${page.totalMessages}:${pageIndex}`),
        threadId,
        messages: imported.messages,
        turns: imported.turns,
        importedAt,
      });
      cursor = page.nextCursor;
      pageIndex += 1;
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

    const workspaceRoot = path.resolve(summary.cwd);
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
    const existingProject = Option.getOrUndefined(
      yield* snapshots.getActiveProjectByWorkspaceRoot(workspaceRoot),
    );
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
    const baseThreadId = ThreadId.make(
      nativeThreadBaseId(input.providerInstanceId, input.sessionId),
    );
    let deterministicThread = readModel.threads.find(
      (thread) => thread.id === baseThreadId && thread.deletedAt === null,
    );
    if (
      input.indexOnly === true &&
      existingBinding === undefined &&
      deterministicThread !== undefined
    ) {
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`native-thread-retry-delete:${deterministicThread.id}`),
        threadId: deterministicThread.id,
      });
      readModel = yield* snapshots.getCommandReadModel();
      deterministicThread = undefined;
    }
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
    if (input.indexOnly === true && existingBinding !== undefined && boundThread !== undefined) {
      return { projectId: project.id, threadId };
    }
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
