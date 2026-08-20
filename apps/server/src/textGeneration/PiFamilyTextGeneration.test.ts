import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { makePiFamilyTextGeneration } from "./PiFamilyTextGeneration.ts";

const provider = ProviderDriverKind.make("pi");
const instanceId = ProviderInstanceId.make("pi_test");
const threadId = ThreadId.make("t3-text-generation-0");
const turnId = TurnId.make("turn-0");

const session: ProviderSession = {
  provider,
  providerInstanceId: instanceId,
  status: "ready",
  runtimeMode: "approval-required",
  cwd: "/tmp/project",
  threadId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const eventBase = {
  eventId: EventId.make("event-0"),
  provider,
  providerInstanceId: instanceId,
  threadId,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const makeAdapter = (
  output: string,
  stopped: string[],
): ProviderAdapterShape<ProviderAdapterError> => {
  let activeThreadId = threadId;
  const makeEvents = (actualThreadId: ThreadId): ReadonlyArray<ProviderRuntimeEvent> => [
    {
      ...eventBase,
      threadId: actualThreadId,
      type: "content.delta",
      turnId,
      payload: { streamKind: "assistant_text", delta: output },
    },
    {
      ...eventBase,
      eventId: EventId.make("event-1"),
      threadId: actualThreadId,
      type: "turn.completed",
      turnId,
      payload: { state: "completed" },
    },
  ];

  return {
    provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      Effect.sync(() => {
        activeThreadId = input.threadId;
        return { ...session, threadId: activeThreadId };
      }),
    sendTurn: () => Effect.succeed({ threadId: activeThreadId, turnId }),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (id) => Effect.sync(() => stopped.push(String(id))),
    listSessions: () => Effect.succeed([{ ...session, threadId: activeThreadId }]),
    hasSession: () => Effect.succeed(true),
    readThread: () => Effect.succeed({ threadId: activeThreadId, turns: [] }),
    rollbackThread: () => Effect.succeed({ threadId: activeThreadId, turns: [] }),
    stopAll: () => Effect.void,
    get streamEvents() {
      return Stream.fromIterable(makeEvents(activeThreadId));
    },
  };
};

describe("Pi-family native text generation", () => {
  it.effect("prompts a dedicated adapter and validates structured output", () =>
    Effect.gen(function* () {
      const stopped: string[] = [];
      const textGeneration = makePiFamilyTextGeneration({
        provider,
        adapter: makeAdapter('{"branch":"feature/native-pi"}', stopped),
      });

      const result = yield* textGeneration.generateBranchName({
        cwd: "/tmp/project",
        message: "Add native Pi support",
        modelSelection: createModelSelection(instanceId, "provider/model"),
      });

      expect(result.branch).toBe("feature/native-pi");
      expect(stopped).toHaveLength(1);
    }),
  );

  it.effect("rejects malformed structured output and still stops the session", () =>
    Effect.gen(function* () {
      const stopped: string[] = [];
      const textGeneration = makePiFamilyTextGeneration({
        provider,
        adapter: makeAdapter("not-json", stopped),
      });

      const result = yield* textGeneration
        .generateBranchName({
          cwd: "/tmp/project",
          message: "Add native Pi support",
          modelSelection: createModelSelection(instanceId, "provider/model"),
        })
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
      }
      expect(stopped).toHaveLength(1);
    }),
  );
});
