// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { ProviderNativeSessionError } from "@t3tools/contracts";
import type { ProviderSubagentTranscriptReadResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type {
  ProviderNativeHistoryMessage,
  ProviderNativeHistoryToolMessage,
} from "../Services/ProviderAdapter.ts";
import {
  asRecord,
  asString,
  type NativeTaskSnapshot,
  type PiFamilyRuntimeKind,
  type RpcEnvelope,
} from "./protocol.ts";
import {
  nativeTaskLifecyclePayload,
  nativeTaskSnapshotsFromPersistedTool,
} from "./NativeTaskProjection.ts";
import { nativeToolItemPayload } from "./NativeToolProjection.ts";
import { nativeTranscriptEntries } from "./NativeSubagentTranscript.ts";

const IMAGE_BLOB_REFERENCE = /^blob:sha256:([a-f0-9]{64})$/;

export interface NativeSessionArchiveInput {
  readonly sessionFile: string;
  readonly runtime: PiFamilyRuntimeKind;
  readonly agentDirectory: string;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: DateTime.formatIso,
  });
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content.length === 0 ? undefined : content;
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    const text =
      asString(record?.text) ??
      asString(record?.thinking) ??
      asString(record?.reasoning) ??
      (record?.type !== "toolCall" ? asString(record?.content) : undefined);
    if (text !== undefined && text.length > 0) parts.push(text);
  }
  const text = parts.join("");
  return text.length > 0 ? text : undefined;
}

function extractImages(
  content: unknown,
): ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }> {
  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    const record = asRecord(part);
    if (record?.type !== "image") return [];
    if (typeof record.data !== "string" || typeof record.mimeType !== "string") {
      throw new ProviderNativeSessionError({
        code: "invalid",
        message: "Native history contains an image without string data and MIME type.",
      });
    }
    return [{ type: "image", data: record.data, mimeType: record.mimeType }];
  });
}

function historyToolCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
type NativeHistoryNode = {
  readonly parentId: string | null;
  readonly record: Record<string, unknown>;
  readonly hasImageBlobs: boolean;
};

class NativeImageBlobResolver {
  private readonly directory: string;
  private readonly values = new Map<string, string | null>();

  constructor(agentDirectory: string) {
    this.directory = NodePath.join(agentDirectory, "blobs");
  }

  private async read(reference: string, encoding: "base64" | "utf8"): Promise<string> {
    const hash = IMAGE_BLOB_REFERENCE.exec(reference)?.[1];
    if (hash === undefined) return reference;
    const key = `${encoding}:${hash}`;
    let value = this.values.get(key);
    if (value === undefined) {
      try {
        value = (await NodeFSP.readFile(NodePath.join(this.directory, hash))).toString(encoding);
      } catch (error) {
        if (asRecord(error)?.code !== "ENOENT") throw error;
        // Preserve missing references, as the native loader does.
        value = null;
      }
      this.values.set(key, value);
    }
    return value ?? reference;
  }

  async resolve(value: unknown, key?: string): Promise<void> {
    if (Array.isArray(value)) {
      for (const item of value) await this.resolve(item, key);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) return;
    if (
      typeof record.data === "string" &&
      typeof record.mimeType === "string" &&
      (key === "images" || (key === "content" && record.type === "image"))
    ) {
      record.data = await this.read(record.data, "base64");
      return;
    }
    if (record.type === "image_generation_call" && typeof record.result === "string") {
      record.result = await this.read(record.result, "base64");
    }
    if (typeof record.image_url === "string") {
      record.image_url = await this.read(record.image_url, "utf8");
    }
    for (const field in record) {
      const child = record[field];
      if (Object.hasOwn(record, field) && child !== null && typeof child === "object") {
        await this.resolve(child, field);
      }
    }
  }
}

type NativeTaskEvidence = {
  readonly status?: NativeTaskSnapshot["status"];
  readonly endedAt?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly runHandles?: NativeTaskSnapshot["runHandles"];
};

function nativeChildSessionCandidates(
  parentSessionFile: string,
  subagentId: string,
): ReadonlyArray<string> {
  if (subagentId.length === 0 || NodePath.basename(subagentId) !== subagentId) return [];
  const artifactsDirectory = parentSessionFile.endsWith(".jsonl")
    ? parentSessionFile.slice(0, -".jsonl".length)
    : undefined;
  if (artifactsDirectory === undefined) return [];
  return [
    NodePath.join(artifactsDirectory, `${subagentId}.jsonl`),
    NodePath.join(NodePath.dirname(parentSessionFile), `${subagentId}.jsonl`),
  ];
}

async function findNativeChildSessionFile(
  parentSessionFile: string,
  subagentId: string,
): Promise<string | undefined> {
  for (const candidate of nativeChildSessionCandidates(parentSessionFile, subagentId)) {
    try {
      const stat = await NodeFSP.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch (error) {
      if (asRecord(error)?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

export interface NativeSubagentTranscriptArchiveInput {
  readonly parentSessionFile: string;
  readonly sessionId: string;
  readonly subagentId: string;
  readonly cursor?: string;
}

export async function readNativeSubagentTranscript(
  input: NativeSubagentTranscriptArchiveInput,
): Promise<ProviderSubagentTranscriptReadResult> {
  const childSessionFile = await findNativeChildSessionFile(
    input.parentSessionFile,
    input.subagentId,
  );
  if (childSessionFile === undefined) {
    throw new ProviderNativeSessionError({
      code: "not_found",
      message: `OMP subagent '${input.subagentId}' transcript was not found for session '${input.sessionId}'.`,
    });
  }
  try {
    return await readNativeSubagentTranscriptFile(childSessionFile, input.cursor);
  } catch (error) {
    if (asRecord(error)?.code !== "ENOENT") throw error;
    throw new ProviderNativeSessionError({
      code: "not_found",
      message: `OMP subagent '${input.subagentId}' transcript is no longer available.`,
    });
  }
}

function nativeChildSessionStatus(
  stopReason: unknown,
  errorMessage: unknown,
): NativeTaskSnapshot["status"] | undefined {
  const reason = typeof stopReason === "string" ? stopReason.toLowerCase() : undefined;
  if (
    reason === "aborted" ||
    reason === "cancelled" ||
    reason === "canceled" ||
    reason === "length"
  ) {
    return "interrupted";
  }
  if (reason === "error") return "failed";
  if (typeof errorMessage === "string" && errorMessage.length > 0) return "failed";
  return undefined;
}

async function readNativeTaskEvidence(
  parentSessionFile: string,
  taskIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, NativeTaskEvidence>> {
  const evidence = new Map<string, NativeTaskEvidence>();
  await Promise.all(
    [...taskIds].map(async (taskId) => {
      const childSessionFile = await findNativeChildSessionFile(parentSessionFile, taskId);
      if (childSessionFile === undefined) return;
      let content: string;
      try {
        content = await NodeFSP.readFile(childSessionFile, "utf8");
      } catch {
        return;
      }
      let latestAssistant: Record<string, unknown> | undefined;
      let latestAssistantTimestamp: string | undefined;
      let yieldedStatus: NativeTaskSnapshot["status"] | undefined;
      let yieldedError: string | undefined;
      let yieldedAt: string | undefined;
      for (const line of content.split(/\r?\n/u)) {
        const record = parseRecord(line);
        if (record === undefined || record.type !== "message") continue;
        const message = asRecord(record.message);
        if (message?.role === "assistant") {
          latestAssistant = message;
          latestAssistantTimestamp = isoTimestamp(record.timestamp ?? message.timestamp);
        }
        if (
          message?.role === "toolResult" &&
          message.toolName === "yield" &&
          message.isError !== true
        ) {
          const details = asRecord(message.details);
          const sections = details?.type;
          const incremental =
            Array.isArray(sections) &&
            sections.length > 0 &&
            sections.every((section) => typeof section === "string");
          if (!incremental && (details?.status === "success" || details?.status === "aborted")) {
            yieldedStatus = details.status === "success" ? "completed" : "failed";
            yieldedError = typeof details.error === "string" ? details.error : undefined;
            yieldedAt = isoTimestamp(record.timestamp ?? message.timestamp);
          }
        }
      }
      const assistantContent = latestAssistant?.content;
      const summary = extractText(assistantContent);
      const error =
        yieldedStatus === undefined
          ? typeof latestAssistant?.errorMessage === "string"
            ? latestAssistant.errorMessage
            : undefined
          : yieldedError;
      const status = yieldedStatus ?? nativeChildSessionStatus(latestAssistant?.stopReason, error);
      const endedAt =
        yieldedStatus === undefined
          ? status === undefined
            ? undefined
            : latestAssistantTimestamp
          : yieldedAt;
      evidence.set(taskId, {
        ...(status === undefined ? {} : { status }),
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(summary === undefined ? {} : { summary }),
        ...(error === undefined ? {} : { error }),
        runHandles: {
          sessionFile: childSessionFile,
          transcriptDir: NodePath.dirname(childSessionFile),
        },
      });
    }),
  );
  return evidence;
}

function taskIdsFromRecord(record: Record<string, unknown>): ReadonlyArray<string> {
  if (record.type !== "message") return [];
  const message = asRecord(record.message);
  if (message?.role !== "toolResult" && message?.role !== "tool") return [];
  const result = asRecord(message.result) ?? asRecord(message.output) ?? message;
  const details = asRecord(result?.details);
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  return progress.flatMap((candidate) => {
    const task = asRecord(candidate);
    const id = typeof task?.id === "string" ? task.id : undefined;
    return id === undefined ? [] : [id];
  });
}
export async function readNativeSubagentTranscriptFile(
  filePath: string,
  cursor?: string,
): Promise<ProviderSubagentTranscriptReadResult> {
  const requestedByte = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(requestedByte) || requestedByte < 0) {
    throw new ProviderNativeSessionError({
      code: "invalid",
      message: "Subagent transcript cursor is invalid.",
    });
  }
  const content = await NodeFSP.readFile(filePath);
  let fromByte = requestedByte;
  let reset = false;
  if (fromByte > content.byteLength) {
    fromByte = 0;
    reset = true;
  }
  const unread = content.subarray(fromByte);
  const lastNewline = unread.lastIndexOf(0x0a);
  const complete = lastNewline < 0 ? unread.subarray(0, 0) : unread.subarray(0, lastNewline + 1);
  const completeText = complete.toString("utf8");
  const records = completeText
    .split(/\r?\n/u)
    .map(parseRecord)
    .filter((record): record is Record<string, unknown> => record !== undefined);
  return {
    entries: nativeTranscriptEntries(records),
    nextCursor: String(fromByte + complete.byteLength),
    reset,
  };
}

export async function readNativeHistoryMessages(
  input: NativeSessionArchiveInput,
): Promise<ReadonlyArray<ProviderNativeHistoryMessage>> {
  const { sessionFile, runtime, agentDirectory } = input;
  const nodes = new Map<string, NativeHistoryNode>();
  let leafId: string | undefined;
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(sessionFile, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    const record = parseRecord(line);
    if (record === undefined || typeof record.id !== "string") continue;
    const parentId =
      record.parentId === null || typeof record.parentId === "string" ? record.parentId : null;
    nodes.set(record.id, {
      parentId,
      record,
      hasImageBlobs: runtime === "omp" && line.includes("blob:sha256:"),
    });
    leafId = record.id;
  }
  const branch: NativeHistoryNode[] = [];
  const visited = new Set<string>();
  while (leafId !== undefined && !visited.has(leafId)) {
    visited.add(leafId);
    const node = nodes.get(leafId);
    if (node === undefined) break;
    branch.push(node);
    leafId = node.parentId ?? undefined;
  }
  branch.reverse();
  const taskIds = new Set(branch.flatMap((node) => taskIdsFromRecord(node.record)));
  const taskEvidence = await readNativeTaskEvidence(sessionFile, taskIds);
  const messages: ProviderNativeHistoryMessage[] = [];
  const toolCalls = new Map<string, RpcEnvelope>();
  let imageBlobs: NativeImageBlobResolver | undefined;
  for (const node of branch) {
    if (node.hasImageBlobs) {
      imageBlobs ??= new NativeImageBlobResolver(agentDirectory);
      await imageBlobs.resolve(node.record);
    }
    messages.push(...historyMessage(node.record, toolCalls, runtime, taskEvidence));
  }
  return messages;
}

function historyMessage(
  record: Record<string, unknown>,
  toolCalls: Map<string, RpcEnvelope>,
  runtime: PiFamilyRuntimeKind,
  taskEvidence: ReadonlyMap<string, NativeTaskEvidence>,
): ReadonlyArray<ProviderNativeHistoryMessage> {
  if (record.type !== "message") return [];
  const message = asRecord(record.message);
  if (message === undefined) return [];
  const timestamp = isoTimestamp(record.timestamp ?? message.timestamp);
  if (timestamp === undefined) return [];
  const role = message.role;
  const model = typeof message.model === "string" ? message.model : undefined;
  const sourceId = typeof record.id === "string" ? record.id : undefined;
  const content = message.content;
  const parts = Array.isArray(content) ? content : [content];
  const output: ProviderNativeHistoryMessage[] = [];
  const pushText = (
    text: string | undefined,
    images: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>,
    sourceIndex = 0,
  ) => {
    if (text === undefined && images.length === 0) return;
    output.push({
      role:
        role === "user"
          ? "user"
          : role === "developer" || role === "system"
            ? "system"
            : "assistant",
      text: text ?? "",
      timestamp,
      ...(model === undefined ? {} : { model }),
      ...(sourceId === undefined ? {} : { sourceId }),
      sourceIndex,
      ...(images.length === 0 ? {} : { images }),
    });
  };
  const pushTool = (
    phase: "started" | "updated" | "completed",
    raw: RpcEnvelope,
    toolCallId: string | undefined,
    sourceIndex: number,
  ) => {
    const previous = toolCallId === undefined ? undefined : toolCalls.get(toolCallId);
    const withContext = previous === undefined ? raw : { ...previous, ...raw };
    if (toolCallId !== undefined) {
      if (phase === "started") toolCalls.set(toolCallId, raw);
      else if (phase === "completed") toolCalls.delete(toolCallId);
    }
    const tasks =
      phase === "started"
        ? []
        : nativeTaskSnapshotsFromPersistedTool(runtime, withContext).map((task) => {
            const evidence = taskEvidence.get(task.id);
            const status =
              task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
                ? task.status
                : (evidence?.status ?? task.status);
            const enriched: NativeTaskSnapshot = {
              ...task,
              status,
              ...(evidence?.summary === undefined ? {} : { summary: evidence.summary }),
              ...(evidence?.error === undefined ? {} : { error: evidence.error }),
              ...(evidence?.runHandles === undefined
                ? {}
                : { runHandles: { ...task.runHandles, ...evidence.runHandles } }),
            };
            return {
              ...nativeTaskLifecyclePayload(enriched),
              ...(evidence?.endedAt === undefined ? {} : { endedAt: evidence.endedAt }),
            };
          });
    const toolMessage: ProviderNativeHistoryToolMessage = {
      role: "tool",
      timestamp,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      phase,
      payload: nativeToolItemPayload(withContext, phase),
      ...(sourceId === undefined ? {} : { sourceId }),
      sourceIndex,
      ...(tasks.length === 0 ? {} : { tasks }),
    };
    output.push(toolMessage);
  };

  if (role === "assistant") {
    for (const [sourceIndex, part] of parts.entries()) {
      const partRecord = asRecord(part);
      const partType = typeof partRecord?.type === "string" ? partRecord.type : undefined;
      if (partType === "toolCall" || partType === "tool_call") {
        const toolCallId = historyToolCallId(
          partRecord?.id ?? partRecord?.toolCallId ?? partRecord?.tool_call_id,
        );
        const toolName =
          typeof partRecord?.name === "string"
            ? partRecord.name
            : typeof partRecord?.toolName === "string"
              ? partRecord.toolName
              : undefined;
        const input = partRecord?.arguments ?? partRecord?.input;
        const raw: RpcEnvelope = {
          type: "tool.started",
          ...(toolCallId === undefined ? {} : { toolCallId, id: toolCallId }),
          ...(toolName === undefined ? {} : { toolName, name: toolName }),
          ...(input === undefined ? {} : { args: input }),
        };
        pushTool("started", raw, toolCallId, sourceIndex);
        continue;
      }
      pushText(extractText(part), extractImages(part), sourceIndex);
    }
    if (output.length > 0) return output;
    pushText(extractText(message.content), extractImages(message.content));
    return output;
  }

  if (role === "toolResult" || role === "tool") {
    const toolCallId = historyToolCallId(message.toolCallId ?? message.tool_call_id ?? message.id);
    const toolName =
      typeof message.toolName === "string"
        ? message.toolName
        : typeof message.name === "string"
          ? message.name
          : undefined;
    const result = message.result ?? message.output ?? message;
    const raw: RpcEnvelope = {
      type: "tool.completed",
      ...(toolCallId === undefined ? {} : { toolCallId, id: toolCallId }),
      ...(toolName === undefined ? {} : { toolName, name: toolName }),
      ...(result === undefined ? {} : { result }),
      ...(message.isError === true ? { isError: true } : {}),
      ...(typeof message.error === "string" ? { error: message.error } : {}),
    };
    const phase =
      message.isPartial === true ||
      message.partial === true ||
      message.status === "in_progress" ||
      message.status === "running"
        ? "updated"
        : "completed";
    pushTool(phase, raw, toolCallId, 0);
    return output;
  }

  if (role === "user" || role === "developer" || role === "system") {
    pushText(extractText(content), extractImages(content));
  }
  return output;
}
