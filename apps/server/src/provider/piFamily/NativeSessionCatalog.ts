// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderInstanceId,
  ProviderNativeSessionStatus,
  ProviderNativeSessionSummary,
  ProviderSubagentTranscriptReadResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { ProviderNativeSessionError } from "@t3tools/contracts";
import type { ProviderNativeHistoryMessage } from "../Services/ProviderAdapter.ts";
import { readNativeHistoryMessages, readNativeSubagentTranscript } from "./NativeSessionArchive.ts";
import type { PiFamilyRuntimeKind } from "./protocol.ts";

const SESSION_PREFIX_BYTES = 16 * 1024;
const SESSION_SUFFIX_BYTES = 32 * 1024;
const isNativeSessionError = Schema.is(ProviderNativeSessionError);
const MAX_SESSION_FILES = 2_000;
export interface PiFamilySessionCatalogConfig {
  readonly runtime: PiFamilyRuntimeKind;
  readonly cwd: string;
  readonly agentDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly launchArguments?: readonly string[];
}

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

function configuredHomeDirectory(config: PiFamilySessionCatalogConfig): string {
  const configuredHome = config.environment?.HOME;
  return configuredHome === undefined || configuredHome.length === 0
    ? NodeOS.homedir()
    : resolveFromCwd(config.cwd, configuredHome);
}

function resolvePiFamilyAgentDirectory(config: PiFamilySessionCatalogConfig): string {
  const agentDirectory = config.agentDirectory ?? config.environment?.PI_CODING_AGENT_DIR;
  if (agentDirectory !== undefined) return resolveFromCwd(config.cwd, agentDirectory);
  const homeDirectory = configuredHomeDirectory(config);
  if (config.runtime === "omp") {
    const profile =
      argumentValue(config.launchArguments, "--profile") ?? config.environment?.OMP_PROFILE;
    if (profile !== undefined) {
      return NodePath.join(homeDirectory, ".omp", "profiles", profile, "agent");
    }
  }
  return NodePath.join(homeDirectory, config.runtime === "omp" ? ".omp" : ".pi", "agent");
}

export function resolvePiFamilySessionDirectory(config: PiFamilySessionCatalogConfig): string {
  const explicitSessionDirectory = argumentValue(config.launchArguments, "--session-dir");
  if (explicitSessionDirectory !== undefined) {
    return resolveFromCwd(config.cwd, explicitSessionDirectory);
  }

  const environmentSessionDirectory = config.environment?.PI_CODING_AGENT_SESSION_DIR;
  if (environmentSessionDirectory !== undefined) {
    return resolveFromCwd(config.cwd, environmentSessionDirectory);
  }

  return NodePath.join(resolvePiFamilyAgentDirectory(config), "sessions");
}

export async function resolvePiFamilyWorkspacePath(value: string): Promise<string> {
  return NodeFSP.realpath(value).catch((error) => {
    if (asRecord(error)?.code === "ENOENT") return value;
    throw error;
  });
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
  if (typeof content === "string") return content.length === 0 ? undefined : content;
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    const text =
      typeof record?.text === "string"
        ? record.text
        : typeof record?.thinking === "string"
          ? record.thinking
          : typeof record?.reasoning === "string"
            ? record.reasoning
            : typeof record?.content === "string" && record.type !== "toolCall"
              ? record.content
              : undefined;
    if (text !== undefined && text.length > 0) parts.push(text);
  }
  const text = parts.join("");
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

function sessionTitle(suffix: string): string | undefined {
  let title: string | undefined;
  for (const rawLine of suffix.split(/\r?\n/u)) {
    const record = parseRecord(rawLine.trim());
    if (record === undefined) continue;
    const candidate =
      record.type === "session_info"
        ? record.name
        : record.type === "title" || record.type === "title_change"
          ? record.title
          : undefined;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      title = candidate.trim();
    }
  }
  return title;
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

async function readWindow(
  filePath: string,
): Promise<{ prefix: string; suffix: string; stat: NodeFS.Stats }> {
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
      stat,
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
interface SessionCatalogEntry {
  readonly filePath: string;
  readonly header: SessionHeader;
  readonly prefix: string;
  readonly suffix: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

async function readSessionCatalogEntry(filePath: string): Promise<SessionCatalogEntry | undefined> {
  try {
    const window = await readWindow(filePath);
    const header = parseSessionHeader(window.prefix);
    if (header === undefined) return undefined;
    const createdAt =
      isoTimestamp(header.timestamp) ??
      isoTimestamp(window.stat.birthtimeMs) ??
      isoTimestamp(window.stat.ctimeMs);
    const updatedAt = isoTimestamp(window.stat.mtimeMs);
    if (createdAt === undefined || updatedAt === undefined) return undefined;
    return {
      filePath,
      header,
      prefix: window.prefix,
      suffix: window.suffix,
      createdAt,
      updatedAt,
    };
  } catch {
    return undefined;
  }
}

async function discoverSessionCatalogEntries(root: string): Promise<SessionCatalogEntry[]> {
  const paths = await discoverSessionFiles(root);
  const entries = await mapConcurrent(paths, 16, readSessionCatalogEntry);
  return entries.filter((entry): entry is SessionCatalogEntry => entry !== undefined);
}

function compareSessionCatalogEntries(
  left: SessionCatalogEntry,
  right: SessionCatalogEntry,
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) || left.filePath.localeCompare(right.filePath)
  );
}

async function entriesForWorkspace(
  entries: SessionCatalogEntry[],
  cwd: string,
): Promise<SessionCatalogEntry[]> {
  const target = NodePath.resolve(cwd);
  const canonicalPaths = new Map<string, Promise<string>>();
  const canonicalPath = (value: string): Promise<string> => {
    let pending = canonicalPaths.get(value);
    if (pending === undefined) {
      pending = resolvePiFamilyWorkspacePath(value);
      canonicalPaths.set(value, pending);
    }
    return pending;
  };
  const matches = await Promise.all(
    entries.map(async (entry) => {
      const candidate = NodePath.resolve(entry.header.cwd);
      return (
        candidate === target || (await canonicalPath(candidate)) === (await canonicalPath(target))
      );
    }),
  );
  return entries.filter((_, index) => matches[index]);
}

export function listPiFamilyNativeSessions(
  config: PiFamilySessionCatalogConfig,
  providerInstanceId: ProviderInstanceId,
  cwd?: string,
): Effect.Effect<ReadonlyArray<ProviderNativeSessionSummary>, ProviderNativeSessionError> {
  const root = resolvePiFamilySessionDirectory(config);
  return Effect.tryPromise({
    try: async () => {
      let entries: SessionCatalogEntry[];
      try {
        entries = await discoverSessionCatalogEntries(root);
      } catch (error) {
        if (asRecord(error)?.code === "ENOENT") return [];
        throw error;
      }
      const summaries = (cwd === undefined ? entries : await entriesForWorkspace(entries, cwd))
        .sort(compareSessionCatalogEntries)
        .map((entry): ProviderNativeSessionSummary => {
          const model = sessionModel(entry.suffix);
          return {
            providerInstanceId,
            runtime: config.runtime,
            sessionId: entry.header.id,
            cwd: entry.header.cwd,
            title:
              sessionTitle(entry.suffix) ??
              entry.header.title ??
              fallbackTitle(entry.prefix) ??
              "Untitled session",
            ...(model !== undefined ? { model } : {}),
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            status: sessionStatus(entry.suffix),
          };
        });
      const seenSessionIds = new Set<string>();
      return summaries.filter((summary) => {
        if (seenSessionIds.has(summary.sessionId)) return false;
        seenSessionIds.add(summary.sessionId);
        return true;
      });
    },
    catch: (cause) =>
      new ProviderNativeSessionError({
        code: "native",
        message: cause instanceof Error ? cause.message : "Failed to list native sessions",
      }),
  });
}

async function findSessionFile(
  root: string,
  sessionId: string,
  cwd: string,
): Promise<string | undefined> {
  const entries = await discoverSessionCatalogEntries(root);
  const matching = await entriesForWorkspace(
    entries.filter((entry) => entry.header.id === sessionId),
    cwd,
  );
  return matching.sort(compareSessionCatalogEntries)[0]?.filePath;
}

export function readPiFamilyNativeSubagentTranscript(
  config: PiFamilySessionCatalogConfig,
  sessionId: string,
  subagentId: string,
  cwd: string,
  cursor?: string,
): Effect.Effect<ProviderSubagentTranscriptReadResult, ProviderNativeSessionError> {
  if (config.runtime !== "omp") {
    return Effect.fail(
      new ProviderNativeSessionError({
        code: "unsupported",
        message: "Subagent transcripts are only available for OMP sessions.",
      }),
    );
  }
  const root = resolvePiFamilySessionDirectory(config);
  return Effect.tryPromise({
    try: async () => {
      const parentSessionFile = await findSessionFile(root, sessionId, cwd);
      if (parentSessionFile === undefined) {
        throw new ProviderNativeSessionError({
          code: "not_found",
          message: `${config.runtime.toUpperCase()} session '${sessionId}' was not found in this project.`,
        });
      }
      return await readNativeSubagentTranscript({
        parentSessionFile,
        sessionId,
        subagentId,
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
    catch: (cause) =>
      isNativeSessionError(cause)
        ? cause
        : new ProviderNativeSessionError({
            code: "native",
            message:
              cause instanceof Error ? cause.message : "Failed to read native subagent transcript",
          }),
  });
}

export function readPiFamilyNativeHistoryMessages(
  config: PiFamilySessionCatalogConfig,
  sessionId: string,
  cwd: string,
): Effect.Effect<ReadonlyArray<ProviderNativeHistoryMessage>, ProviderNativeSessionError> {
  const root = resolvePiFamilySessionDirectory(config);
  return Effect.tryPromise({
    try: async () => {
      const sessionFile = await findSessionFile(root, sessionId, cwd);
      if (sessionFile === undefined) {
        throw new ProviderNativeSessionError({
          code: "not_found",
          message: `${config.runtime.toUpperCase()} session '${sessionId}' was not found in this project.`,
        });
      }
      return await readNativeHistoryMessages({
        sessionFile,
        runtime: config.runtime,
        agentDirectory: resolvePiFamilyAgentDirectory(config),
      });
    },
    catch: (cause) =>
      isNativeSessionError(cause)
        ? cause
        : new ProviderNativeSessionError({
            code: "native",
            message: cause instanceof Error ? cause.message : "Failed to read native history",
          }),
  });
}
