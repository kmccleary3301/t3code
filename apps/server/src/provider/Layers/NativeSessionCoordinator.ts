import {
  CommandId,
  MessageId,
  ProviderNativeSessionError,
  ProviderNativeSessionResumeCursor,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ProviderNativeSessionListRequest,
  type ProviderNativeSessionOpenInput,
  type ProviderNativeSessionSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderNativeHistoryMessage } from "../Services/ProviderAdapter.ts";
import * as NativeSessionCoordinator from "../Services/NativeSessionCoordinator.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";

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

function historyWasImported(runtimePayload: unknown): boolean {
  return asRecord(runtimePayload)?.nativeHistoryImported === true;
}

function nativeThreadBaseId(providerInstanceId: string, sessionId: string): string {
  return `native:${providerInstanceId}:${sessionId}`;
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

type ImportedTurn = OrchestrationLatestTurn & { readonly assistantMessageId: MessageId | null };

function appendNativeHistoryPage(input: {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<ProviderNativeHistoryMessage>;
  readonly messageOffset: number;
  readonly turnOffset: number;
  readonly currentTurn: ImportedTurn | null;
}): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly turns: ReadonlyArray<OrchestrationLatestTurn>;
  readonly messageOffset: number;
  readonly turnOffset: number;
  readonly currentTurn: ImportedTurn | null;
} {
  const messages: OrchestrationMessage[] = [];
  const turns: OrchestrationLatestTurn[] = [];
  let messageOffset = input.messageOffset;
  let turnOffset = input.turnOffset;
  let currentTurn = input.currentTurn;
  let currentTurnDirty = false;

  const flushCurrentTurn = () => {
    if (currentTurn !== null && currentTurnDirty) turns.push(currentTurn);
    currentTurnDirty = false;
  };

  for (const nativeMessage of input.messages) {
    messageOffset += 1;
    const messageId = MessageId.make(`native:${input.sessionId}:message:${messageOffset}`);
    if (nativeMessage.role === "system") {
      messages.push({
        id: messageId,
        role: "system",
        text: nativeMessage.text,
        turnId: null,
        streaming: false,
        createdAt: nativeMessage.timestamp,
        updatedAt: nativeMessage.timestamp,
      });
      continue;
    }

    if (nativeMessage.role === "user") {
      flushCurrentTurn();
      turnOffset += 1;
      currentTurn = {
        turnId: TurnId.make(`native:${input.sessionId}:turn:${turnOffset}`),
        state: "interrupted",
        requestedAt: nativeMessage.timestamp,
        startedAt: nativeMessage.timestamp,
        completedAt: null,
        assistantMessageId: null,
      };
      currentTurnDirty = true;
    } else if (currentTurn === null) {
      turnOffset += 1;
      currentTurn = {
        turnId: TurnId.make(`native:${input.sessionId}:turn:${turnOffset}`),
        state: "completed",
        requestedAt: nativeMessage.timestamp,
        startedAt: nativeMessage.timestamp,
        completedAt: nativeMessage.timestamp,
        assistantMessageId: messageId,
      };
      currentTurnDirty = true;
    } else {
      currentTurn = {
        ...currentTurn,
        state: "completed",
        startedAt: currentTurn.startedAt ?? nativeMessage.timestamp,
        completedAt: nativeMessage.timestamp,
        assistantMessageId: messageId,
      };
      currentTurnDirty = true;
    }

    messages.push({
      id: messageId,
      role: nativeMessage.role,
      text: nativeMessage.text,
      turnId: currentTurn.turnId,
      streaming: false,
      createdAt: nativeMessage.timestamp,
      updatedAt: nativeMessage.timestamp,
    });
  }
  flushCurrentTurn();
  return { messages, turns, messageOffset, turnOffset, currentTurn };
}

const makeNativeSessionCoordinator = Effect.gen(function* () {
  const providerService = yield* ProviderService.ProviderService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const openSemaphore = yield* Semaphore.make(1);

  const listInternal = Effect.fn("NativeSessionCoordinator.listInternal")(function* (
    input: ProviderNativeSessionListRequest,
  ) {
    const readModel = yield* snapshots.getCommandReadModel();
    let cwd: string | undefined;
    if (input.projectId !== undefined) {
      const project = readModel.projects.find(
        (candidate) => candidate.id === input.projectId && candidate.deletedAt === null,
      );
      if (project === undefined) {
        return yield* new ProviderNativeSessionError({
          code: "not_found",
          message: `Project '${input.projectId}' was not found.`,
        });
      }
      cwd = project.workspaceRoot;
    }
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find(
      (candidate) => candidate.instanceId === input.providerInstanceId,
    );
    if (
      provider === undefined ||
      provider.driver !== "omp" ||
      !provider.enabled ||
      !provider.installed
    ) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: `Provider '${input.providerInstanceId}' is not an available OMP instance.`,
      });
    }
    const listNativeSessions = providerService.listNativeSessions;
    if (listNativeSessions === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "unsupported",
        message: "This server has no native session catalog.",
      });
    }
    const sessions =
      cwd === undefined
        ? yield* listNativeSessions({ providerInstanceId: input.providerInstanceId })
        : yield* listNativeSessions({ providerInstanceId: input.providerInstanceId, cwd });
    return { sessions };
  });

  const importHistory = Effect.fn("NativeSessionCoordinator.importHistory")(function* (
    threadId: ThreadId,
    sessionId: string,
  ) {
    let cursor: string | undefined;
    let pageIndex = 0;
    let messageOffset = 0;
    let turnOffset = 0;
    let currentTurn: ImportedTurn | null = null;
    do {
      const readNativeHistory = providerService.readNativeHistory;
      if (readNativeHistory === undefined) {
        return yield* new ProviderNativeSessionError({
          code: "unsupported",
          message: "This server has no native history reader.",
        });
      }
      const page = yield* readNativeHistory({
        threadId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const imported = appendNativeHistoryPage({
        sessionId,
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
        commandId: CommandId.make(`native-history:${sessionId}:${page.totalMessages}:${pageIndex}`),
        threadId,
        messages: imported.messages,
        turns: imported.turns,
        importedAt,
      });
      cursor = page.nextCursor;
      pageIndex += 1;
    } while (cursor !== undefined);
  });

  const openInternal = Effect.fn("NativeSessionCoordinator.openInternal")(function* (
    input: ProviderNativeSessionOpenInput,
  ) {
    const listed = yield* listInternal({
      projectId: input.projectId,
      providerInstanceId: input.providerInstanceId,
    });
    const summary = listed.sessions.find((session) => session.sessionId === input.sessionId);
    if (summary === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "not_found",
        message: `OMP session '${input.sessionId}' was not found in this project.`,
      });
    }

    const readModel = yield* snapshots.getCommandReadModel();
    const project = readModel.projects.find(
      (candidate) => candidate.id === input.projectId && candidate.deletedAt === null,
    );
    if (project === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "not_found",
        message: `Project '${input.projectId}' was not found.`,
      });
    }
    const bindings = yield* directory.listBindings();
    const existingBinding = bindings.find(
      (binding) =>
        binding.providerInstanceId === input.providerInstanceId &&
        isNativeResumeCursor(binding.resumeCursor) &&
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
    const deterministicThread = readModel.threads.find(
      (thread) => thread.id === baseThreadId && thread.deletedAt === null,
    );
    let thread: Pick<OrchestrationThread, "id" | "modelSelection"> | undefined =
      boundThread ?? deterministicThread;
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find(
      (candidate) => candidate.instanceId === input.providerInstanceId,
    );
    const modelSelection = chooseModelSelection(
      summary,
      project.defaultModelSelection,
      provider?.models ?? [],
    );
    if (modelSelection === undefined) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: `OMP session '${input.sessionId}' has no recoverable model.`,
      });
    }

    if (thread === undefined) {
      const collided = readModel.threads.some((candidate) => candidate.id === baseThreadId);
      const threadId = collided
        ? ThreadId.make(`${baseThreadId}:${DateTime.toEpochMillis(yield* DateTime.now)}`)
        : baseThreadId;
      const createdAt = summary.createdAt;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`native-thread-create:${threadId}`),
        threadId,
        projectId: input.projectId,
        title: summary.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      thread = {
        id: threadId,
        modelSelection,
      };
    }

    const threadId = thread.id;
    const activeSession = (yield* providerService.listSessions()).find(
      (session) => session.threadId === threadId,
    );
    if (
      activeSession !== undefined &&
      (activeSession.providerInstanceId !== input.providerInstanceId ||
        !isNativeResumeCursor(activeSession.resumeCursor) ||
        activeSession.resumeCursor.sessionId !== input.sessionId)
    ) {
      return yield* new ProviderNativeSessionError({
        code: "invalid",
        message: `Thread '${threadId}' is already bound to a different provider session.`,
      });
    }
    const session =
      activeSession ??
      (yield* providerService.startSession(threadId, {
        threadId,
        providerInstanceId: input.providerInstanceId,
        cwd: summary.cwd,
        title: summary.title,
        modelSelection,
        resumeCursor: {
          kind: "native-session",
          runtime: "omp",
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

    const nativeHistoryImported =
      existingBinding?.threadId === threadId && historyWasImported(existingBinding.runtimePayload);
    if (!nativeHistoryImported) {
      yield* importHistory(threadId, input.sessionId);
      const currentBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      if (currentBinding !== undefined) {
        const runtimePayload = asRecord(currentBinding.runtimePayload);
        yield* directory.upsert({
          ...currentBinding,
          runtimePayload: { ...runtimePayload, nativeHistoryImported: true },
        });
      }
    }
    return { threadId };
  });

  return {
    list: (input) => listInternal(input).pipe(Effect.mapError(asNativeSessionError)),
    open: (input) =>
      openSemaphore.withPermits(1)(openInternal(input)).pipe(Effect.mapError(asNativeSessionError)),
  } satisfies NativeSessionCoordinator.NativeSessionCoordinatorShape;
});

export const NativeSessionCoordinatorLive = Layer.effect(
  NativeSessionCoordinator.NativeSessionCoordinator,
  makeNativeSessionCoordinator,
);
