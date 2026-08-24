// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  gitRefExists,
  gitShowFileAtRef,
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import type {
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);

const PROJECT_ID = asProjectId("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const FIXTURE_TURN_ID = "fixture-turn";
const APPROVAL_REQUEST_ID = asApprovalRequestId("req-approval-1");
type IntegrationProvider = ProviderDriverKind;
const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");

function nowIso() {
  return "2026-05-01T00:00:00.000Z";
}

class IntegrationWaitTimeoutError extends Schema.TaggedErrorClass<IntegrationWaitTimeoutError>()(
  "IntegrationWaitTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitForSync<A>(
  read: () => A,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<A, never> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;

    while (true) {
      const value = read();
      if (predicate(value)) {
        return value;
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new IntegrationWaitTimeoutError({ description }));
      }
      yield* Effect.sleep(10);
    }
  });
}

function runtimeBase(
  eventId: string,
  createdAt: string,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return {
    eventId: asEventId(eventId),
    provider,
    createdAt,
  };
}

function withHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
  provider: IntegrationProvider = CODEX_PROVIDER,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

function withRealCodexHarness<A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: CODEX_PROVIDER, realCodex: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const provider = harness.adapterHarness?.provider ?? CODEX_PROVIDER;
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
    const instanceId = defaultInstanceIdForDriver(provider);

    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId: PROJECT_ID,
      title: "Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: {
        instanceId,
        model: defaultModel,
      },
      createdAt,
    });

    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Integration Thread",
      modelSelection: {
        instanceId,
        model: defaultModel,
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

const startTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
  readonly createdAt?: string;
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: asMessageId(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: input.modelSelection,
        }
      : {}),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: input.createdAt ?? nowIso(),
  });

it.live("runs a single turn end-to-end and persists checkpoint state in sqlite + git", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      const turnResponse: TestTurnResponse = {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-single-1", "2026-02-24T10:00:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-single-2", "2026-02-24T10:00:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Single turn response.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-single-3", "2026-02-24T10:00:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      };

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(turnResponse);
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-single",
        messageId: "msg-user-single",
        text: "Say hello",
      });
      const finalizedReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );
      if (finalizedReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(finalizedReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "ready" &&
          entry.messages.some(
            (message) => message.role === "assistant" && message.streaming === false,
          ) &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.checkpoints[0]?.status, "ready");
      assert.equal(thread.checkpoints[0]?.checkpointTurnCount, 1);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
      assert.equal(checkpointRows[0]?.checkpointTurnCount, 1);
      assert.equal(checkpointRows[0]?.status, "ready");
      assert.deepEqual(checkpointRows[0]?.files, []);

      const ref0 = checkpointRefForThreadTurn(THREAD_ID, 0);
      const ref1 = checkpointRefForThreadTurn(THREAD_ID, 1);
      assert.equal(gitRefExists(harness.workspaceDir, ref0), true);
      assert.equal(gitRefExists(harness.workspaceDir, ref1), true);
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref0, "README.md"), "v1\n");
      assert.equal(gitShowFileAtRef(harness.workspaceDir, ref1, "README.md"), "v1\n");
    }),
  ),
);

it.live.skipIf(!process.env.CODEX_BINARY_PATH)(
  "keeps the same Codex provider thread across runtime mode switches",
  () =>
    withRealCodexHarness((harness) =>
      Effect.gen(function* () {
        const createdAt = nowIso();

        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-real-codex"),
          projectId: PROJECT_ID,
          title: "Integration Project",
          workspaceRoot: harness.workspaceDir,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create-real-codex"),
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Integration Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: harness.workspaceDir,
          createdAt,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-real-codex-1"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-1"),
            role: "user",
            text: "Reply with exactly ALPHA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: nowIso(),
        });

        const firstThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.streaming === false,
            ),
          180_000,
        );
        assert.equal(firstThread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-real-codex-2"),
          threadId: THREAD_ID,
          message: {
            messageId: asMessageId("msg-real-codex-2"),
            role: "user",
            text: "Reply with exactly BETA.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        const secondThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.status === "ready" &&
            entry.session.providerName === "codex" &&
            entry.session.runtimeMode === "approval-required" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text.includes("BETA"),
            ),
          180_000,
        );
        assert.equal(secondThread.session?.threadId, "thread-1");
      }),
    ),
);

it.live("runs multi-turn file edits and persists checkpoint diffs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-1", "2026-02-24T10:01:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-multi-2", "2026-02-24T10:01:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-multi-3", "2026-02-24T10:01:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-4", "2026-02-24T10:01:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-5", "2026-02-24T10:01:00.400Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-1",
        messageId: "msg-user-multi-1",
        text: "Make first edit",
      });
      yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 1,
      );

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.checkpoints.length === 1 && entry.session?.threadId === "thread-1",
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-multi-6", "2026-02-24T10:02:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-multi-7", "2026-02-24T10:02:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-multi-8", "2026-02-24T10:02:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-multi-2",
        messageId: "msg-user-multi-2",
        text: "Make second edit",
      });
      const secondReceipt = yield* harness.waitForReceipt(
        (receipt): receipt is CheckpointDiffFinalizedReceipt =>
          receipt.type === "checkpoint.diff.finalized" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );
      if (secondReceipt.type !== "checkpoint.diff.finalized") {
        throw new Error("Expected checkpoint.diff.finalized receipt.");
      }
      assert.equal(secondReceipt.status, "ready");
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" &&
          receipt.threadId === THREAD_ID &&
          receipt.checkpointTurnCount === 2,
      );

      const secondTurnThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 2),
      );
      const secondCheckpoint = secondTurnThread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === 2,
      );
      assert.equal(
        secondCheckpoint?.files.some((file) => file.path === "README.md"),
        true,
      );

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.deepEqual(
        checkpointRows.map((row) => row.checkpointTurnCount),
        [1, 2],
      );

      const incrementalDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 1),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });
      assert.equal(incrementalDiff.includes("README.md"), true);

      const fullDiff = yield* harness.checkpointStore.diffCheckpoints({
        cwd: harness.workspaceDir,
        fromCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 0),
        toCheckpointRef: checkpointRefForThreadTurn(THREAD_ID, 2),
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      });
      assert.equal(fullDiff.includes("README.md"), true);

      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 1),
          "README.md",
        ),
        "v2\n",
      );
      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(THREAD_ID, 2),
          "README.md",
        ),
        "v3\n",
      );
    }),
  ),
);

it.live("tracks approval requests and resolves pending approvals on user response", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-approval-1", "2026-02-24T10:03:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "approval.requested",
            ...runtimeBase("evt-approval-2", "2026-02-24T10:03:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            requestId: APPROVAL_REQUEST_ID,
            requestKind: "command",
            detail: "Approve command execution",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-approval-3", "2026-02-24T10:03:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-approval",
        messageId: "msg-user-approval",
        text: "Run command needing approval",
      });

      const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
        entry.activities.some((activity) => activity.kind === "approval.requested"),
      );
      assert.equal(
        thread.activities.some((activity) => activity.kind === "approval.requested"),
        true,
      );

      const pendingRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "pending" && row.decision === null,
      );
      assert.equal(pendingRow.status, "pending");

      yield* harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: THREAD_ID,
        requestId: APPROVAL_REQUEST_ID,
        decision: "accept",
        createdAt: nowIso(),
      });

      const resolvedRow = yield* harness.waitForPendingApproval(
        "req-approval-1",
        (row) => row.status === "resolved" && row.decision === "accept",
      );
      assert.equal(resolvedRow.status, "resolved");
      assert.equal(resolvedRow.decision, "accept");

      const approvalResponses = yield* waitForSync(
        () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
        (responses) => responses.length === 1,
        "provider approval response",
      );
      assert.equal(approvalResponses.length, 1);
      assert.equal(approvalResponses[0]?.requestId, "req-approval-1");
      assert.equal(approvalResponses[0]?.decision, "accept");
    }),
  ),
);

it.live("records failed turn runtime state and checkpoint status as error", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-failure-1", "2026-02-24T10:04:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "content.delta",
            ...runtimeBase("evt-failure-2", "2026-02-24T10:04:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              streamKind: "assistant_text",
              delta: "Partial output before failure.\n",
            },
          },
          {
            type: "runtime.error",
            ...runtimeBase("evt-failure-3", "2026-02-24T10:04:00.200Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              message: "Sandbox command failed.",
            },
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-failure-4", "2026-02-24T10:04:00.300Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            payload: {
              state: "failed",
              errorMessage: "Sandbox command failed.",
            },
          },
        ],
      });

      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-failure",
        messageId: "msg-user-failure",
        text: "Run risky command",
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.session?.status === "error" &&
          entry.session?.lastError === "Sandbox command failed." &&
          entry.activities.some((activity) => activity.kind === "runtime.error") &&
          entry.checkpoints.length === 1,
      );
      assert.equal(thread.session?.status, "error");
      assert.equal(thread.checkpoints[0]?.status, "error");

      const checkpointRow = yield* harness.checkpointRepository.getByThreadAndTurnCount({
        threadId: THREAD_ID,
        checkpointTurnCount: 1,
      });
      assert.equal(Option.isSome(checkpointRow), true);
      if (Option.isSome(checkpointRow)) {
        assert.equal(checkpointRow.value.status, "error");
      }
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
        true,
      );
    }),
  ),
);

it.live("reverts to an earlier checkpoint and trims checkpoint projections + git refs", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-1", "2026-02-24T10:05:00.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-1-tool-started", "2026-02-24T10:05:00.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-1-tool-completed", "2026-02-24T10:05:00.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-1a", "2026-02-24T10:05:00.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v2.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-2", "2026-02-24T10:05:00.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-1",
        messageId: "msg-user-revert-1",
        text: "First edit",
        createdAt: "2026-02-24T10:04:59.900Z",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.threadId === "thread-1" && entry.checkpoints.length === 1,
      );

      yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
        events: [
          {
            type: "turn.started",
            ...runtimeBase("evt-revert-3", "2026-02-24T10:05:01.000Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
          },
          {
            type: "tool.started",
            ...runtimeBase("evt-revert-3-tool-started", "2026-02-24T10:05:01.025Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "tool.completed",
            ...runtimeBase("evt-revert-3-tool-completed", "2026-02-24T10:05:01.035Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            toolKind: "command",
            title: "Edit file",
            detail: "README.md",
          },
          {
            type: "message.delta",
            ...runtimeBase("evt-revert-3a", "2026-02-24T10:05:01.050Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            delta: "Updated README to v3.\n",
          },
          {
            type: "turn.completed",
            ...runtimeBase("evt-revert-4", "2026-02-24T10:05:01.100Z"),
            threadId: THREAD_ID,
            turnId: FIXTURE_TURN_ID,
            status: "completed",
          },
        ],
        mutateWorkspace: ({ cwd }) =>
          Effect.sync(() => {
            NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
          }),
      });
      yield* startTurn({
        harness,
        commandId: "cmd-turn-start-revert-2",
        messageId: "msg-user-revert-2",
        text: "Second edit",
        createdAt: "2026-02-24T10:05:00.900Z",
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.latestTurn?.turnId === "turn-2" &&
          entry.checkpoints.length === 2 &&
          entry.activities.some((activity) => activity.turnId === "turn-2"),
        8000,
      );

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-checkpoint-revert"),
        threadId: THREAD_ID,
        turnCount: 1,
        createdAt: nowIso(),
      });

      yield* harness.waitForDomainEvent((event) => event.type === "thread.reverted");
      const revertedThread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
      );
      assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
      assert.deepEqual(
        revertedThread.messages.map((message) => ({ role: message.role, text: message.text })),
        [
          { role: "user", text: "First edit" },
          { role: "assistant", text: "Updated README to v2.\n" },
        ],
      );
      assert.equal(
        revertedThread.activities.some((activity) => activity.turnId === "turn-2"),
        false,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.started",
        ),
        true,
      );
      assert.equal(
        revertedThread.activities.some(
          (activity) => activity.turnId === "turn-1" && activity.kind === "tool.completed",
        ),
        true,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(harness.workspaceDir, "README.md"), "utf8"),
        "v2\n",
      );
      assert.equal(
        gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
        false,
      );
      assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);

      const checkpointRows = yield* harness.checkpointRepository.listByThreadId({
        threadId: THREAD_ID,
      });
      assert.equal(checkpointRows.length, 1);
    }),
  ),
);

it.live(
  "appends checkpoint.revert.failed activity when revert is requested without an active session",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-no-session"),
          threadId: THREAD_ID,
          turnCount: 0,
          createdAt: nowIso(),
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some(
            (activity) =>
              activity.kind === "checkpoint.revert.failed" &&
              typeof activity.payload === "object" &&
              activity.payload !== null,
          ),
        );
        const failureActivity = thread.activities.find(
          (activity) => activity.kind === "checkpoint.revert.failed",
        );
        assert.equal(failureActivity !== undefined, true);
        assert.equal(
          String(
            (failureActivity?.payload as { readonly detail?: string } | undefined)?.detail,
          ).includes("No active provider session"),
          true,
        );
      }),
    ),
);

it.live("starts a claudeAgent session on first turn when provider is requested", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-start-1",
                "2026-02-24T10:10:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-start-2",
                "2026-02-24T10:10:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Claude first turn.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-start-3",
                "2026-02-24T10:10:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-initial",
          messageId: "msg-user-claude-initial",
          text: "Use Claude",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.session.status === "ready" &&
            entry.messages.some(
              (message) => message.role === "assistant" && message.text === "Claude first turn.\n",
            ),
        );
        assert.equal(thread.session?.providerName, "claudeAgent");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("recovers claudeAgent sessions after provider stopAll using persisted resume state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-recover-1",
                "2026-02-24T10:11:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-recover-2",
                "2026-02-24T10:11:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn before restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-recover-3",
                "2026-02-24T10:11:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-1",
          messageId: "msg-user-claude-recover-1",
          text: "Before restart",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.adapter.stopAll();
        yield* waitForSync(
          () => harness.adapterHarness!.listActiveSessionIds(),
          (sessionIds) => sessionIds.length === 0,
          "provider stopAll",
        );

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-recover-4",
                "2026-02-24T10:11:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-recover-5",
                "2026-02-24T10:11:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Turn after restart.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-recover-6",
                "2026-02-24T10:11:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-recover-2",
          messageId: "msg-user-claude-recover-2",
          text: "After restart",
        });
        yield* waitForSync(
          () => harness.adapterHarness!.getStartCount(),
          (count) => count === 2,
          "claude provider recovery start",
        );

        const recoveredThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.session?.providerName === "claudeAgent" &&
            entry.messages.some(
              (message) => message.role === "user" && message.text === "After restart",
            ) &&
            !entry.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        );
        assert.equal(recoveredThread.session?.providerName, "claudeAgent");
        assert.equal(recoveredThread.session?.threadId, "thread-1");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);
it.live("reprojects persisted events after a server restart", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const beforeRestart = yield* harness.waitForThread(
        THREAD_ID,
        (thread) => thread.title === "Integration Thread",
      );
      const rootDir = harness.rootDir;
      yield* harness.dispose;

      const database = new NodeSqlite.DatabaseSync(harness.dbPath);
      try {
        database.exec(`
          DELETE FROM projection_thread_messages;
          DELETE FROM projection_thread_activities;
          DELETE FROM projection_thread_proposed_plans;
          DELETE FROM projection_thread_sessions;
          DELETE FROM projection_turns;
          DELETE FROM projection_pending_approvals;
          DELETE FROM projection_threads;
          DELETE FROM projection_projects;
          DELETE FROM projection_state;
        `);
      } finally {
        database.close();
      }

      yield* Effect.scoped(
        Effect.acquireUseRelease(
          makeOrchestrationIntegrationHarness({
            provider: CODEX_PROVIDER,
            rootDir,
          }).pipe(Effect.provide(NodeServices.layer)),
          (restarted) =>
            Effect.gen(function* () {
              const afterRestart = yield* restarted.waitForThread(
                THREAD_ID,
                (thread) => thread.title === "Integration Thread",
              );
              assert.deepEqual(afterRestart, beforeRestart);
            }),
          (restarted) => restarted.dispose.pipe(Effect.orDie),
        ),
      );
    }),
  ),
);

it.live("forwards claudeAgent approval responses to the provider session", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-approval-1",
                "2026-02-24T10:12:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "approval.requested",
              ...runtimeBase(
                "evt-claude-approval-2",
                "2026-02-24T10:12:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              requestId: APPROVAL_REQUEST_ID,
              requestKind: "command",
              detail: "Approve Claude tool call",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-approval-3",
                "2026-02-24T10:12:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-approval",
          messageId: "msg-user-claude-approval",
          text: "Need approval",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(THREAD_ID, (entry) =>
          entry.activities.some((activity) => activity.kind === "approval.requested"),
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-claude-approval-respond"),
          threadId: THREAD_ID,
          requestId: APPROVAL_REQUEST_ID,
          decision: "accept",
          createdAt: nowIso(),
        });

        yield* harness.waitForPendingApproval(
          "req-approval-1",
          (row) => row.status === "resolved" && row.decision === "accept",
        );

        const approvalResponses = yield* waitForSync(
          () => harness.adapterHarness!.getApprovalResponses(THREAD_ID),
          (responses) => responses.length === 1,
          "claude provider approval response",
        );
        assert.equal(approvalResponses[0]?.decision, "accept");
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("forwards thread.turn.interrupt to claudeAgent provider sessions", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-interrupt-1",
                "2026-02-24T10:13:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-interrupt-2",
                "2026-02-24T10:13:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "Long running output.\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-interrupt-3",
                "2026-02-24T10:13:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-interrupt",
          messageId: "msg-user-claude-interrupt",
          text: "Start long turn",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.session?.threadId === "thread-1",
        );
        assert.equal(thread.session?.threadId, "thread-1");

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-claude"),
          threadId: THREAD_ID,
          createdAt: nowIso(),
        });
        yield* harness.waitForDomainEvent(
          (event) => event.type === "thread.turn-interrupt-requested",
        );

        const interruptCalls = yield* waitForSync(
          () => harness.adapterHarness!.getInterruptCalls(THREAD_ID),
          (calls) => calls.length === 1,
          "claude provider interrupt call",
        );
        assert.equal(interruptCalls.length, 1);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);

it.live("reverts claudeAgent turns and rolls back provider conversation state", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        yield* harness.adapterHarness!.queueTurnResponseForNextSession({
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-1",
                "2026-02-24T10:14:00.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-2",
                "2026-02-24T10:14:00.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v2\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-3",
                "2026-02-24T10:14:00.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-1",
          messageId: "msg-user-claude-revert-1",
          text: "First Claude edit",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-1" && entry.session?.threadId === "thread-1",
        );

        yield* harness.adapterHarness!.queueTurnResponse(THREAD_ID, {
          events: [
            {
              type: "turn.started",
              ...runtimeBase(
                "evt-claude-revert-4",
                "2026-02-24T10:14:01.000Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
            },
            {
              type: "message.delta",
              ...runtimeBase(
                "evt-claude-revert-5",
                "2026-02-24T10:14:01.050Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              delta: "README -> v3\n",
            },
            {
              type: "turn.completed",
              ...runtimeBase(
                "evt-claude-revert-6",
                "2026-02-24T10:14:01.100Z",
                CLAUDE_AGENT_PROVIDER,
              ),
              threadId: THREAD_ID,
              turnId: FIXTURE_TURN_ID,
              status: "completed",
            },
          ],
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
            }),
        });

        yield* startTurn({
          harness,
          commandId: "cmd-turn-start-claude-revert-2",
          messageId: "msg-user-claude-revert-2",
          text: "Second Claude edit",
        });

        yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.latestTurn?.turnId === "turn-2" &&
            entry.checkpoints.length === 2 &&
            entry.session?.providerName === "claudeAgent",
        );

        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-checkpoint-revert-claude"),
          threadId: THREAD_ID,
          turnCount: 1,
          createdAt: nowIso(),
        });

        const revertedThread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) =>
            entry.checkpoints.length === 1 && entry.checkpoints[0]?.checkpointTurnCount === 1,
        );
        assert.equal(revertedThread.checkpoints[0]?.checkpointTurnCount, 1);
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 1)),
          true,
        );
        assert.equal(
          gitRefExists(harness.workspaceDir, checkpointRefForThreadTurn(THREAD_ID, 2)),
          false,
        );
        assert.deepEqual(harness.adapterHarness!.getRollbackCalls(THREAD_ID), [1]);
      }),
    CLAUDE_AGENT_PROVIDER,
  ),
);
class NativeMatrixHarnessError extends Schema.TaggedErrorClass<NativeMatrixHarnessError>()(
  "NativeMatrixHarnessError",
  {
    cause: Schema.Defect(),
  },
) {}

const nativeMatrixHarnessError = (cause: unknown) => new NativeMatrixHarnessError({ cause });
// A non-retaining sink opts the adapter into its bounded child-exit observation without
// persisting native prompt/output bytes in this credential-free lifecycle test.
const nativeMatrixTraceSinkFactory = {
  create: () => ({
    recordBytes: () => {},
    recordExit: () => {},
    invalidate: () => {},
    finalize: () => {},
  }),
};
type NativeMatrixRuntime = "pi" | "omp";

interface NativeMatrixConfig {
  readonly runtime: NativeMatrixRuntime;
  readonly provider: ProviderDriverKind;
  readonly binaryPath: string;
  readonly launchArguments: ReadonlyArray<string>;
  readonly trustMode?: string;
}

interface NativeMatrixModelServer {
  readonly baseUrl: string;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}

const makeNativeMatrixModelServer = Effect.tryPromise<
  NativeMatrixModelServer,
  NativeMatrixHarnessError
>({
  try: () =>
    new Promise((resolve, reject) => {
      let requestCount = 0;
      const pendingTimers = new Set<NodeJS.Timeout>();
      const server = NodeHttp.createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
          response.writeHead(404);
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("error", () => response.destroy());
        request.on("end", () => {
          requestCount += 1;
          let message = "";
          let bodyText = "";
          try {
            bodyText = Buffer.concat(chunks).toString("utf8");
            const body = JSON.parse(bodyText) as {
              readonly messages?: ReadonlyArray<{
                readonly content?: unknown;
              }>;
            };
            const content = body.messages?.at(-1)?.content;
            message = typeof content === "string" ? content : JSON.stringify(content ?? "");
          } catch {
            response.writeHead(400);
            response.end();
            return;
          }
          const delayMs = bodyText.includes("NATIVE-MATRIX-HOLD")
            ? 10_000
            : bodyText.includes("NATIVE-MATRIX-WRITE")
              ? 500
              : 0;
          let timer: NodeJS.Timeout | undefined;
          const send = () => {
            if (timer !== undefined) {
              pendingTimers.delete(timer);
              timer = undefined;
            }
            const marker = message.includes("RESTORED")
              ? "NATIVE-MATRIX-RESTORED-OK"
              : "NATIVE-MATRIX-OK";
            const frames = [
              {
                id: `native-matrix-${requestCount}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: marker },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: `native-matrix-${requestCount}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ];
            if (!response.headersSent) {
              response.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
            }
            response.end(
              `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
            );
          };
          if (delayMs > 0) {
            if (!response.headersSent) {
              response.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
              response.flushHeaders();
            }
            response.write(": native-matrix-hold\n\n");
            // @effect-diagnostics-next-line globalTimers:off - Native HTTP test server delay.
            timer = setTimeout(send, delayMs);
            pendingTimers.add(timer);
            request.once("close", () => {
              if (timer !== undefined) {
                clearTimeout(timer);
                pendingTimers.delete(timer);
                timer = undefined;
              }
            });
          } else {
            send();
          }
        });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Native matrix model server did not expose a TCP address."));
          return;
        }
        resolve({
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          requestCount: () => requestCount,
          close: () =>
            new Promise<void>((closeResolve) => {
              for (const timer of pendingTimers) clearTimeout(timer);
              pendingTimers.clear();
              server.closeAllConnections();
              server.closeIdleConnections();
              server.close(() => closeResolve());
            }),
        });
      });
    }),
  catch: nativeMatrixHarnessError,
});

const makeNativeMatrixAgentDirectory = Effect.tryPromise({
  try: async () => {
    const directory = await NodeFS.promises.mkdtemp("/tmp/t3-native-matrix-");
    await NodeFS.promises.chmod(directory, 0o700);
    return directory;
  },
  catch: nativeMatrixHarnessError,
});

const writeNativeMatrixConfig = (
  config: NativeMatrixConfig,
  agentDirectory: string,
  modelServer: NativeMatrixModelServer,
) =>
  Effect.tryPromise({
    try: async () => {
      if (config.runtime === "pi") {
        await NodeFS.promises.writeFile(
          NodePath.join(agentDirectory, "models.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Pi model test config is JSON.
          JSON.stringify({
            providers: {
              local: {
                baseUrl: modelServer.baseUrl,
                api: "openai-completions",
                apiKey: "native-matrix",
                models: [
                  {
                    id: "test",
                    name: "Native Matrix Test",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 128_000,
                    maxTokens: 1024,
                  },
                ],
              },
            },
          }),
          { mode: 0o600 },
        );
        await NodeFS.promises.writeFile(
          NodePath.join(agentDirectory, "settings.json"),
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Pi settings test config is JSON.
          JSON.stringify({
            defaultProvider: "local",
            defaultModel: "test",
            defaultThinkingLevel: "off",
          }),
          { mode: 0o600 },
        );
        return;
      }
      await NodeFS.promises.writeFile(
        NodePath.join(agentDirectory, "models.yml"),
        [
          "providers:",
          "  local:",
          `    baseUrl: ${modelServer.baseUrl}`,
          "    api: openai-completions",
          "    auth: none",
          "    models:",
          "      - id: test",
          "        name: Native Matrix Test",
          "        reasoning: false",
          "        input: [text]",
          "        contextWindow: 128000",
          "        maxTokens: 1024",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
    },
    catch: nativeMatrixHarnessError,
  });

const nativeMatrixConfiguration = (
  runtime: NativeMatrixRuntime,
): NativeMatrixConfig | undefined => {
  const binaryPath = process.env[`T3_NATIVE_${runtime.toUpperCase()}_BINARY`]?.trim();
  if (!binaryPath) return undefined;
  return {
    runtime,
    provider: ProviderDriverKind.make(runtime),
    binaryPath,
    launchArguments:
      runtime === "pi"
        ? [
            "--mode",
            "rpc",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--offline",
            "--provider",
            "local",
            "--model",
            "local/test",
          ]
        : [
            "--mode",
            "rpc",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-rules",
            "--no-title",
            "--provider",
            "local",
            "--model",
            "local/test",
          ],
    ...(runtime === "pi" ? { trustMode: "approve-for-this-run" } : {}),
  };
};

const runNativeMatrix = (config: NativeMatrixConfig) =>
  Effect.acquireUseRelease(
    makeNativeMatrixModelServer,
    (modelServer) =>
      Effect.acquireUseRelease(
        makeNativeMatrixAgentDirectory,
        (agentDirectory) =>
          Effect.gen(function* () {
            yield* writeNativeMatrixConfig(config, agentDirectory, modelServer);
            yield* Effect.acquireUseRelease(
              makeOrchestrationIntegrationHarness({
                provider: config.provider,
                nativeLive: {
                  runtime: config.runtime,
                  binaryPath: config.binaryPath,
                  launchArguments: config.launchArguments,
                  agentDirectory,
                  environment: { PI_OFFLINE: "1", PI_NO_PTY: "1" },
                  ...(config.trustMode === undefined ? {} : { trustMode: config.trustMode }),
                  traceSinkFactory: nativeMatrixTraceSinkFactory,
                },
              }),
              (harness) =>
                Effect.gen(function* () {
                  const projectId = ProjectId.make(`native-matrix-${config.runtime}-project`);
                  const threadId = ThreadId.make(`native-matrix-${config.runtime}-thread`);
                  const instanceId = ProviderInstanceId.make(config.runtime);
                  const modelSelection = {
                    instanceId,
                    model: "local/test",
                  } as const;
                  const createdAt = "2026-08-23T00:00:00.000Z";
                  yield* harness.engine.dispatch({
                    type: "project.create",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:project-create`),
                    projectId,
                    title: `${config.runtime} native matrix project`,
                    workspaceRoot: harness.workspaceDir,
                    defaultModelSelection: modelSelection,
                    createdAt,
                  });
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:thread-create`),
                    threadId,
                    projectId,
                    title: `${config.runtime} native matrix thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });
                  const startTurn = (ordinal: number, text: string, targetThreadId = threadId) =>
                    harness.engine.dispatch({
                      type: "thread.turn.start",
                      commandId: CommandId.make(`native-matrix:${config.runtime}:turn:${ordinal}`),
                      threadId: targetThreadId,
                      message: {
                        messageId: MessageId.make(
                          `native-matrix-${config.runtime}-user-${ordinal}`,
                        ),
                        role: "user",
                        text,
                        attachments: [],
                      },
                      modelSelection,
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      createdAt,
                    });
                  const completedAssistantCounts = new Map<string, number>();
                  const waitForCompleted = (
                    messageText: string,
                    assistantMarker: string,
                    description: string,
                    targetThreadId = threadId,
                  ) => {
                    const markerKey = `${String(targetThreadId)}:${assistantMarker}`;
                    const previousAssistantCount = completedAssistantCounts.get(markerKey) ?? 0;
                    const countMatchingAssistants = (thread: {
                      messages: ReadonlyArray<{ role: string; streaming: boolean; text: string }>;
                    }) =>
                      thread.messages.filter(
                        (message) =>
                          message.role === "assistant" &&
                          !message.streaming &&
                          message.text.includes(assistantMarker),
                      ).length;
                    return harness
                      .waitForThread(
                        targetThreadId,
                        (thread) => {
                          const latestTurn = thread.latestTurn;
                          if (
                            latestTurn === null ||
                            latestTurn.state !== "completed" ||
                            thread.session?.status !== "ready"
                          ) {
                            return false;
                          }
                          const userMessageIndex = thread.messages.findLastIndex(
                            (message) => message.role === "user" && message.text === messageText,
                          );
                          return (
                            userMessageIndex >= 0 &&
                            countMatchingAssistants(thread) > previousAssistantCount
                          );
                        },
                        30_000,
                      )
                      .pipe(
                        Effect.tap((thread) =>
                          Effect.sync(() => {
                            completedAssistantCounts.set(
                              markerKey,
                              countMatchingAssistants(thread),
                            );
                          }),
                        ),
                        Effect.tap(() => Effect.logInfo(description)),
                      );
                  };
                  const waitForNativeProcessExit = () =>
                    Effect.gen(function* () {
                      const deadline = (yield* Clock.currentTimeMillis) + 30_000;
                      while (true) {
                        const sessions = yield* harness.providerService.listSessions();
                        if (!sessions.some((session) => session.threadId === threadId)) {
                          return;
                        }
                        if ((yield* Clock.currentTimeMillis) >= deadline) {
                          return yield* Effect.die(
                            new IntegrationWaitTimeoutError({
                              description: `${config.runtime} native process exit`,
                            }),
                          );
                        }
                        yield* Effect.sleep(10);
                      }
                    });

                  const firstMessage = "Reply with the native matrix marker.";
                  yield* startTurn(1, firstMessage);
                  const first = yield* waitForCompleted(
                    firstMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} native root turn`,
                  );
                  assert.equal(first.session?.providerName, config.runtime);
                  assert.isAbove(modelServer.requestCount(), 0);
                  assert.isTrue(
                    first.messages.some(
                      (message) => message.text.includes("NATIVE-MATRIX-OK") && !message.streaming,
                    ),
                  );

                  const secondMessage = "Complete a second native turn for checkpoint capture.";
                  yield* startTurn(2, secondMessage);
                  const second = yield* waitForCompleted(
                    secondMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} second native turn`,
                  );
                  const nativeCheckpoint = yield* harness.providerService.captureNativeCheckpoint({
                    threadId,
                  });
                  const hasNativeCheckpoint = nativeCheckpoint !== undefined;
                  assert.equal(
                    hasNativeCheckpoint,
                    config.runtime === "pi",
                    `${config.runtime} native checkpoint capability mismatch`,
                  );
                  if (nativeCheckpoint !== undefined) {
                    yield* harness.providerService.restoreNativeCheckpoint({
                      threadId,
                      checkpoint: nativeCheckpoint,
                    });
                  }

                  const restoredMessage =
                    nativeCheckpoint === undefined
                      ? "Continue with the native matrix turn."
                      : "Reply with the RESTORED native matrix marker.";
                  const restoredDescription =
                    nativeCheckpoint === undefined
                      ? `${config.runtime} continuation turn`
                      : `${config.runtime} restored turn`;
                  yield* startTurn(3, restoredMessage);
                  const restored = yield* waitForCompleted(
                    restoredMessage,
                    nativeCheckpoint === undefined
                      ? "NATIVE-MATRIX-OK"
                      : "NATIVE-MATRIX-RESTORED-OK",
                    restoredDescription,
                  );
                  assert.isTrue(
                    restored.messages.some(
                      (message) =>
                        message.role === "assistant" &&
                        message.text.length > 0 &&
                        !message.streaming,
                    ),
                  );
                  const holdMessage = "NATIVE-MATRIX-HOLD";
                  const turnStartedFiber = yield* harness.providerService.streamEvents.pipe(
                    Stream.filter(
                      (event) => event.threadId === threadId && event.type === "turn.started",
                    ),
                    Stream.runHead,
                    Effect.forkChild,
                  );
                  const turnSettledFiber = yield* harness.providerService.streamEvents.pipe(
                    Stream.filter(
                      (event) => event.threadId === threadId && event.type === "turn.completed",
                    ),
                    Stream.runHead,
                    Effect.forkChild,
                  );
                  const modelRequestsBeforeHold = modelServer.requestCount();
                  const interruptStartFiber = yield* startTurn(4, holdMessage).pipe(
                    Effect.forkChild,
                  );
                  const started = yield* Fiber.join(turnStartedFiber).pipe(
                    Effect.timeout("10 seconds"),
                  );
                  assert.equal(
                    started._tag,
                    "Some",
                    `${config.runtime} native turn did not emit turn.started`,
                  );
                  if (started._tag !== "Some") {
                    return yield* Effect.die(
                      "Native matrix running turn did not expose a turn ID.",
                    );
                  }
                  const runningTurnId = started.value.turnId;
                  const holdRequestDeadline = (yield* Clock.currentTimeMillis) + 10_000;
                  while (modelServer.requestCount() <= modelRequestsBeforeHold) {
                    if ((yield* Clock.currentTimeMillis) >= holdRequestDeadline) {
                      return yield* Effect.die(
                        new IntegrationWaitTimeoutError({
                          description: `${config.runtime} native hold request`,
                        }),
                      );
                    }
                    yield* Effect.sleep(10);
                  }
                  yield* harness.engine.dispatch({
                    type: "thread.turn.interrupt",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:interrupt`),
                    threadId,
                    turnId: runningTurnId,
                    createdAt,
                  });
                  yield* harness.waitForDomainEvent(
                    (event) =>
                      event.type === "thread.turn-interrupt-requested" &&
                      event.payload.threadId === threadId &&
                      event.payload.turnId === runningTurnId,
                    10_000,
                  );
                  const settled = yield* Fiber.join(turnSettledFiber).pipe(
                    Effect.timeout("10 seconds"),
                  );
                  assert.equal(
                    settled._tag,
                    "Some",
                    `${config.runtime} native turn did not settle after interrupt`,
                  );
                  if (settled._tag !== "Some") {
                    return yield* Effect.die("Native matrix interrupted turn did not settle.");
                  }
                  if (settled.value.type !== "turn.completed") {
                    return yield* Effect.die(
                      "Native matrix interruption did not emit turn.completed.",
                    );
                  }
                  assert.equal(settled.value.turnId, runningTurnId);
                  assert.equal(settled.value.payload.state, "interrupted");
                  const interrupted = yield* harness.waitForThread(
                    threadId,
                    (thread) =>
                      thread.latestTurn?.turnId === runningTurnId &&
                      thread.latestTurn?.state === "interrupted" &&
                      thread.session?.status === "ready",
                    10_000,
                  );
                  assert.equal(interrupted.latestTurn?.turnId, runningTurnId);
                  assert.equal(interrupted.latestTurn?.state, "interrupted");
                  assert.equal(interrupted.session?.status, "ready");

                  yield* harness.engine.dispatch({
                    type: "thread.session.stop",
                    commandId: CommandId.make(`native-matrix:${config.runtime}:stop`),
                    threadId,
                    createdAt,
                  });
                  const stopped = yield* harness.waitForThread(
                    threadId,
                    (thread) =>
                      thread.session?.status === "stopped" || thread.session?.status === "error",
                    30_000,
                  );
                  assert.equal(
                    stopped.session?.status,
                    "stopped",
                    `${config.runtime} stop failed: ${stopped.session?.lastError ?? "unknown"}`,
                  );
                  yield* waitForNativeProcessExit();
                  yield* Fiber.interrupt(interruptStartFiber).pipe(Effect.ignore);
                  const restartedThreadId = ThreadId.make(
                    `native-matrix-${config.runtime}-restart-thread`,
                  );
                  yield* harness.engine.dispatch({
                    type: "thread.create",
                    commandId: CommandId.make(
                      `native-matrix:${config.runtime}:restart-thread-create`,
                    ),
                    threadId: restartedThreadId,
                    projectId,
                    title: `${config.runtime} native restart thread`,
                    modelSelection,
                    runtimeMode: "approval-required",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: harness.workspaceDir,
                    createdAt,
                  });
                  const restartedMessage = "Reply after the native session restart.";
                  yield* startTurn(5, restartedMessage, restartedThreadId);
                  const restarted = yield* waitForCompleted(
                    restartedMessage,
                    "NATIVE-MATRIX-OK",
                    `${config.runtime} restarted turn`,
                    restartedThreadId,
                  );
                  assert.equal(restarted.session?.providerName, config.runtime);
                }),
              (harness) => harness.dispose,
            );
          }),
        (agentDirectory) =>
          Effect.tryPromise({
            try: () => NodeFS.promises.rm(agentDirectory, { recursive: true, force: true }),
            catch: nativeMatrixHarnessError,
          }),
      ),
    (modelServer) =>
      Effect.tryPromise({
        try: modelServer.close,
        catch: nativeMatrixHarnessError,
      }),
  ).pipe(Effect.provide(NodeServices.layer));

const nativeMatrixRuntimeFilter = process.env.T3_NATIVE_LIVE_RUNTIME?.trim();
const nativeMatrixConfigurations = (["pi", "omp"] as const)
  .map(nativeMatrixConfiguration)
  .filter(
    (config): config is NativeMatrixConfig =>
      config !== undefined &&
      (nativeMatrixRuntimeFilter === undefined || config.runtime === nativeMatrixRuntimeFilter),
  );
if (nativeMatrixConfigurations.length > 0) {
  it.live(
    "runs configured Pi and OMP through the native T3 lifecycle matrices",
    () =>
      Effect.forEach(nativeMatrixConfigurations, runNativeMatrix, {
        concurrency: 1,
        discard: true,
      }),
    120_000,
  );
}
