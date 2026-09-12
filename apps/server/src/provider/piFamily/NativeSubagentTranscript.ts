import type {
  ProviderSubagentTranscriptEntry,
  ProviderSubagentTranscriptReadResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { asNumber, asRecord, asString, type RpcResponse } from "./protocol.ts";
function transcriptPartText(part: unknown): string | undefined {
  const record = asRecord(part);
  return (
    asString(record?.text) ??
    asString(record?.thinking) ??
    asString(record?.content) ??
    asString(record?.summary)
  );
}

function nativeTranscriptTextParts(content: unknown): ReadonlyArray<string> {
  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    const text = typeof part === "string" ? part : transcriptPartText(part);
    return text === undefined || text.length === 0 ? [] : [text];
  });
}

function rpcTranscriptTextParts(content: unknown): ReadonlyArray<string> {
  if (typeof content === "string") return content.length === 0 ? [] : [content];
  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    const text = transcriptPartText(part);
    return text === undefined || text.length === 0 ? [] : [text];
  });
}

function archivedTranscriptId(id: unknown, index: number): string {
  return typeof id === "string" && id.length > 0 ? id : `message-${index}`;
}

function rpcTranscriptId(id: unknown, index: number): string {
  return asString(id) ?? `message-${index}`;
}

function formatTranscriptEntries(
  values: ReadonlyArray<unknown>,
  entryId: (id: unknown, index: number) => string,
  textParts: (content: unknown) => ReadonlyArray<string>,
): ReadonlyArray<ProviderSubagentTranscriptEntry> {
  const transcriptEntries: ProviderSubagentTranscriptEntry[] = [];
  for (const [entryIndex, value] of values.entries()) {
    const entry = asRecord(value);
    const message = asRecord(entry?.message);
    if (entry?.type !== "message" || message === undefined) continue;
    const baseId = entryId(entry.id, entryIndex);
    const candidateTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const timestamp =
      candidateTimestamp !== undefined && !Number.isNaN(Date.parse(candidateTimestamp))
        ? candidateTimestamp
        : DateTime.formatIso(DateTime.nowUnsafe());
    const role = typeof message.role === "string" ? message.role : "system";
    const content = message.content;
    const parts = Array.isArray(content) ? content : [content];
    let emittedPart = 0;

    for (const part of parts) {
      const partRecord = asRecord(part);
      const partType = typeof partRecord?.type === "string" ? partRecord.type : undefined;
      const toolName =
        typeof partRecord?.name === "string"
          ? partRecord.name
          : typeof partRecord?.toolName === "string"
            ? partRecord.toolName
            : typeof message.toolName === "string"
              ? message.toolName
              : undefined;
      if (role === "assistant" && (partType === "toolCall" || partType === "tool_call")) {
        const argumentsValue = partRecord?.arguments ?? partRecord?.input;
        const serializedArguments =
          argumentsValue === undefined ? undefined : JSON.stringify(argumentsValue, null, 2);
        transcriptEntries.push({
          id: `${baseId}:${emittedPart++}`,
          kind: "tool",
          text: `Called ${toolName ?? "tool"}${
            serializedArguments === undefined ? "" : `\n${serializedArguments}`
          }`,
          timestamp,
          ...(toolName === undefined ? {} : { toolName }),
        });
        continue;
      }
      for (const text of textParts(part)) {
        const kind =
          role === "user"
            ? "user"
            : role === "assistant" && (partType === "thinking" || partType === "reasoning")
              ? "reasoning"
              : role === "assistant"
                ? "assistant"
                : role === "toolResult" || role === "tool"
                  ? "tool"
                  : "system";
        transcriptEntries.push({
          id: `${baseId}:${emittedPart++}`,
          kind,
          text,
          timestamp,
          ...(toolName === undefined ? {} : { toolName }),
          ...(kind === "tool" && message.isError === true ? { isError: true } : {}),
        });
      }
    }

    if (emittedPart > 0) continue;
    const summary =
      typeof message.summary === "string"
        ? message.summary
        : typeof message.text === "string"
          ? message.text
          : typeof message.message === "string"
            ? message.message
            : undefined;
    if (summary === undefined || summary.length === 0) continue;
    transcriptEntries.push({
      id: `${baseId}:0`,
      kind: "system",
      text: summary,
      timestamp,
    });
  }
  return transcriptEntries;
}

export function nativeTranscriptEntries(
  values: ReadonlyArray<unknown>,
): ReadonlyArray<ProviderSubagentTranscriptEntry> {
  return formatTranscriptEntries(values, archivedTranscriptId, nativeTranscriptTextParts);
}

export function transcriptEntriesFromResponse(
  response: RpcResponse,
): ProviderSubagentTranscriptReadResult | undefined {
  const data = asRecord(response.data);
  const nextByte = asNumber(data?.nextByte);
  if (nextByte === undefined || !Array.isArray(data?.entries)) return undefined;
  return {
    entries: formatTranscriptEntries(data.entries, rpcTranscriptId, rpcTranscriptTextParts),
    nextCursor: String(Math.max(0, Math.trunc(nextByte))),
    reset: data?.reset === true,
  };
}
