import {
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type ThreadId,
} from "@t3tools/contracts";

import type { ProviderNativeHistoryMessage } from "../Services/ProviderAdapter.ts";

export type ImportedNativeTurn = OrchestrationLatestTurn & {
  readonly assistantMessageId: MessageId | null;
};

export function appendNativeHistoryPage(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ProviderNativeHistoryMessage>;
  readonly messageOffset: number;
  readonly turnOffset: number;
  readonly currentTurn: ImportedNativeTurn | null;
}): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly turns: ReadonlyArray<OrchestrationLatestTurn>;
  readonly messageOffset: number;
  readonly turnOffset: number;
  readonly currentTurn: ImportedNativeTurn | null;
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
    const messageId = MessageId.make(`native-message:${input.threadId}:${messageOffset}`);
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
        turnId: TurnId.make(`native-turn:${input.threadId}:${turnOffset}`),
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
        turnId: TurnId.make(`native-turn:${input.threadId}:${turnOffset}`),
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
