// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type {
  ProviderInstanceId,
  ProviderNativeSessionStatus,
  ProviderNativeSessionSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { ProviderNativeSessionError } from "@t3tools/contracts";
import type { ProviderNativeHistoryMessage } from "../Services/ProviderAdapter.ts";

import type { PiFamilyNativeConfig } from "./NativeAdapter.ts";

const SESSION_PREFIX_BYTES = 16 * 1024;
const SESSION_SUFFIX_BYTES = 32 * 1024;
const isNativeSessionError = Schema.is(ProviderNativeSessionError);
const MAX_SESSION_FILES = 2_000;

type SessionHeader = {
  readonly id: string;
  readonly cwd: string;
  readonly title?: string;
  readonly timestamp?: string;
};

function argumentValue(
  arguments_: readonly string[] | undefined,
  name: string,
): string | undefined {
  if (arguments_ === undefined) return undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === name) return arguments_[index + 1];
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  }
  return undefined;
}

function resolveFromCwd(cwd: string, directory: string): string {
  return NodePath.isAbsolute(directory) ? directory : NodePath.resolve(cwd, directory);
}

export function resolveOmpSessionDirectory(config: PiFamilyNativeConfig): string {
  const explicitSessionDirectory = argumentValue(config.launchArguments, "--session-dir");
  if (explicitSessionDirectory !== undefined) {
    return resolveFromCwd(config.cwd, explicitSessionDirectory);
  }

  const agentDirectory = config.agentDirectory ?? config.environment?.PI_CODING_AGENT_DIR;
  if (agentDirectory !== undefined) {
    return NodePath.join(resolveFromCwd(config.cwd, agentDirectory), "sessions");
  }

  const profile =
    argumentValue(config.launchArguments, "--profile") ?? config.environment?.OMP_PROFILE;
  if (profile !== undefined) {
    return NodePath.join(NodeOS.homedir(), ".omp", "profiles", profile, "agent", "sessions");
  }
  return NodePath.join(NodeOS.homedir(), ".omp", "agent", "sessions");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function parseSessionHeader(prefix: string): SessionHeader | undefined {
  let titleOverride: string | undefined;
  for (const rawLine of prefix.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const record = parseRecord(line);
    if (record === undefined) continue;
    if (record.type === "title") {
      if (typeof record.title === "string" && record.title.trim().length > 0) {
        titleOverride = record.title.trim();
      }
      continue;
    }
    if (
      record.type !== "session" ||
      typeof record.id !== "string" ||
      typeof record.cwd !== "string"
    ) {
      return undefined;
    }
    return {
      id: record.id,
      cwd: record.cwd,
      ...(titleOverride !== undefined
        ? { title: titleOverride }
        : typeof record.title === "string" && record.title.trim().length > 0
          ? { title: record.title.trim() }
          : {}),
      ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    };
  }
  return undefined;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  const text = parts.join(" ").trim();
  return text.length > 0 ? text : undefined;
}

function fallbackTitle(prefix: string): string | undefined {
  for (const rawLine of prefix.split(/\r?\n/u)) {
    const record = parseRecord(rawLine);
    const message = asRecord(record?.message);
    if (record?.type !== "message" || message?.role !== "user") continue;
    const text = extractText(message.content);
    if (text !== undefined) return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }
  return undefined;
}

function statusFromMessage(message: Record<string, unknown>): ProviderNativeSessionStatus {
  if (message.role === "assistant") {
    if (message.stopReason === "error") return "error";
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "length") return "interrupted";
    if (
      Array.isArray(message.content) &&
      message.content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "toolCall",
      )
    ) {
      return "interrupted";
    }
    return "complete";
  }
  if (message.role === "toolResult") return "interrupted";
  if (message.role === "user") return "pending";
  return "unknown";
}

function sessionStatus(suffix: string): ProviderNativeSessionStatus {
  const lines = suffix.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseRecord(lines[index] ?? "");
    const message = asRecord(record?.message);
    if (record?.type !== "message" || message === undefined) continue;
    return statusFromMessage(message);
  }
  return "unknown";
}

function modelSlug(provider: unknown, id: unknown): string | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  return typeof provider === "string" && provider.length > 0 && !id.includes("/")
    ? `${provider}/${id}`
    : id;
}

function sessionModel(suffix: string): string | undefined {
  const lines = suffix.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseRecord(lines[index] ?? "");
    if (record === undefined) continue;
    if (record.type === "model_change") {
      const model = modelSlug(record.provider, record.modelId ?? record.model);
      if (model !== undefined) return model;
    }
    const message = asRecord(record.message);
    if (record.type === "message") {
      const model = modelSlug(message?.provider, message?.model);
      if (model !== undefined) return model;
    }
  }
  return undefined;
}

async function readWindow(filePath: string): Promise<{ prefix: string; suffix: string }> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const prefixLength = Math.min(stat.size, SESSION_PREFIX_BYTES);
    const suffixLength = Math.min(stat.size, SESSION_SUFFIX_BYTES);
    const prefixBuffer = Buffer.allocUnsafe(prefixLength);
    const suffixBuffer = Buffer.allocUnsafe(suffixLength);
    await handle.read(prefixBuffer, 0, prefixLength, 0);
    await handle.read(suffixBuffer, 0, suffixLength, Math.max(0, stat.size - suffixLength));
    return {
      prefix: prefixBuffer.toString("utf8"),
      suffix: suffixBuffer.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}
async function discoverSessionFiles(root: string): Promise<readonly string[]> {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(NodePath.join(root, entry.name));
      if (files.length >= MAX_SESSION_FILES) return files;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directoryPath = NodePath.join(root, entry.name);
    let children: NodeFS.Dirent[];
    try {
      children = await NodeFSP.readdir(directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
      files.push(NodePath.join(directoryPath, child.name));
      if (files.length >= MAX_SESSION_FILES) return files;
    }
  }
  return files;
}

async function mapConcurrent<A, B>(
  values: readonly A[],
  concurrency: number,
  transform: (value: A) => Promise<B>,
): Promise<B[]> {
  const results: B[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await transform(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export function listOmpNativeSessions(
  config: PiFamilyNativeConfig,
  providerInstanceId: ProviderInstanceId,
  cwd?: string,
): Effect.Effect<ReadonlyArray<ProviderNativeSessionSummary>, ProviderNativeSessionError> {
  if (config.runtime !== "omp") {
    return Effect.fail(
      new ProviderNativeSessionError({
        code: "unsupported",
        message: "Native sessions require OMP",
      }),
    );
  }
  const root = resolveOmpSessionDirectory(config);
  return Effect.tryPromise({
    try: async () => {
      let paths: readonly string[];
      try {
        paths = await discoverSessionFiles(root);
      } catch (error) {
        if (asRecord(error)?.code === "ENOENT") return [];
        throw error;
      }
      const summaries = await mapConcurrent(
        paths,
        16,
        async (filePath): Promise<ProviderNativeSessionSummary | undefined> => {
          try {
            const [window, stat] = await Promise.all([
              readWindow(filePath),
              NodeFSP.stat(filePath),
            ]);
            const header = parseSessionHeader(window.prefix);
            if (
              header === undefined ||
              (cwd !== undefined && NodePath.resolve(header.cwd) !== NodePath.resolve(cwd))
            ) {
              return undefined;
            }
            const createdAt =
              isoTimestamp(header.timestamp) ??
              isoTimestamp(stat.birthtimeMs) ??
              isoTimestamp(stat.ctimeMs);
            const updatedAt = isoTimestamp(stat.mtimeMs);
            if (createdAt === undefined || updatedAt === undefined) return undefined;
            const model = sessionModel(window.suffix);
            return {
              providerInstanceId,
              sessionId: header.id,
              cwd: header.cwd,
              title: header.title ?? fallbackTitle(window.prefix) ?? "Untitled session",
              ...(model !== undefined ? { model } : {}),
              createdAt,
              updatedAt,
              status: sessionStatus(window.suffix),
            };
          } catch {
            return undefined;
          }
        },
      );
      const ordered = summaries
        .filter((summary): summary is ProviderNativeSessionSummary => summary !== undefined)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const seenSessionIds = new Set<string>();
      return ordered.filter((summary) => {
        if (seenSessionIds.has(summary.sessionId)) return false;
        seenSessionIds.add(summary.sessionId);
        return true;
      });
    },
    catch: (cause) =>
      new ProviderNativeSessionError({
        code: "native",
        message: cause instanceof Error ? cause.message : "Failed to list OMP sessions",
      }),
  });
}

type NativeHistoryNode = {
  readonly parentId: string | null;
  readonly message?: ProviderNativeHistoryMessage;
};

function historyMessage(record: Record<string, unknown>): ProviderNativeHistoryMessage | undefined {
  if (record.type !== "message") return undefined;
  const message = asRecord(record.message);
  if (message === undefined) return undefined;
  const role =
    message?.role === "user"
      ? "user"
      : message?.role === "assistant"
        ? "assistant"
        : message?.role === "developer" || message?.role === "system"
          ? "system"
          : undefined;
  if (role === undefined) return undefined;
  const text = extractText(message.content);
  if (text === undefined) return undefined;
  const timestamp = isoTimestamp(record.timestamp ?? message.timestamp);
  if (timestamp === undefined) return undefined;
  return {
    role,
    text,
    timestamp,
    ...(typeof message.model === "string" ? { model: message.model } : {}),
  };
}

async function findSessionFile(
  root: string,
  sessionId: string,
  cwd: string,
): Promise<string | undefined> {
  const paths = await discoverSessionFiles(root);
  const matches = await mapConcurrent(paths, 16, async (filePath) => {
    try {
      const { prefix } = await readWindow(filePath);
      const header = parseSessionHeader(prefix);
      return header?.id === sessionId && NodePath.resolve(header.cwd) === NodePath.resolve(cwd)
        ? filePath
        : undefined;
    } catch {
      return undefined;
    }
  });
  return matches.find((path): path is string => path !== undefined);
}

export function readOmpNativeHistoryMessages(
  config: PiFamilyNativeConfig,
  sessionId: string,
  cwd: string,
): Effect.Effect<ReadonlyArray<ProviderNativeHistoryMessage>, ProviderNativeSessionError> {
  if (config.runtime !== "omp") {
    return Effect.fail(
      new ProviderNativeSessionError({
        code: "unsupported",
        message: "Native history requires OMP",
      }),
    );
  }
  const root = resolveOmpSessionDirectory(config);
  return Effect.tryPromise({
    try: async () => {
      const filePath = await findSessionFile(root, sessionId, cwd);
      if (filePath === undefined) {
        throw new ProviderNativeSessionError({
          code: "not_found",
          message: `OMP session '${sessionId}' was not found in this project.`,
        });
      }
      const nodes = new Map<string, NativeHistoryNode>();
      let leafId: string | undefined;
      const lines = NodeReadline.createInterface({
        input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of lines) {
        const record = parseRecord(line);
        if (record === undefined || typeof record.id !== "string") continue;
        const parentId =
          record.parentId === null || typeof record.parentId === "string" ? record.parentId : null;
        const message = historyMessage(record);
        nodes.set(record.id, {
          parentId,
          ...(message === undefined ? {} : { message }),
        });
        leafId = record.id;
      }
      const messages: ProviderNativeHistoryMessage[] = [];
      const visited = new Set<string>();
      while (leafId !== undefined && !visited.has(leafId)) {
        visited.add(leafId);
        const node = nodes.get(leafId);
        if (node === undefined) break;
        if (node.message !== undefined) messages.push(node.message);
        leafId = node.parentId ?? undefined;
      }
      messages.reverse();
      return messages;
    },
    catch: (cause) =>
      isNativeSessionError(cause)
        ? cause
        : new ProviderNativeSessionError({
            code: "native",
            message: cause instanceof Error ? cause.message : "Failed to read OMP history",
          }),
  });
}
