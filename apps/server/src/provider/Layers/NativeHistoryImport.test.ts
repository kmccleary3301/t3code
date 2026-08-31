import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { appendNativeHistoryPage } from "./NativeHistoryImport.ts";

const userMessage = {
  role: "user" as const,
  text: "Continue",
  timestamp: "2026-08-01T12:00:00.000Z",
};
const assistantMessage = {
  role: "assistant" as const,
  text: "Done",
  timestamp: "2026-08-01T12:00:01.000Z",
};

function firstPage(threadId: ThreadId) {
  return appendNativeHistoryPage({
    threadId,
    messages: [userMessage],
    messageOffset: 0,
    turnOffset: 0,
    currentTurn: null,
  });
}

describe("appendNativeHistoryPage", () => {
  it("scopes imported identities to the T3 thread, not the provider session id", () => {
    const first = firstPage(ThreadId.make("native:omp-work:shared-session"));
    const second = firstPage(ThreadId.make("native:omp-personal:shared-session"));

    expect(first.messages[0]?.id).not.toBe(second.messages[0]?.id);
    expect(first.turns[0]?.turnId).not.toBe(second.turns[0]?.turnId);
  });

  it("continues one turn and monotonically advances message identities across pages", () => {
    const threadId = ThreadId.make("native:omp:session-1");
    const first = firstPage(threadId);
    const second = appendNativeHistoryPage({
      threadId,
      messages: [assistantMessage],
      messageOffset: first.messageOffset,
      turnOffset: first.turnOffset,
      currentTurn: first.currentTurn,
    });

    expect(first.messages[0]?.id).toBe("native-message:native:omp:session-1:1");
    expect(second.messages[0]?.id).toBe("native-message:native:omp:session-1:2");
    expect(second.messages[0]?.turnId).toBe(first.turns[0]?.turnId);
    expect(second.turns[0]?.state).toBe("completed");
  });
});
