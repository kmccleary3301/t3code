import {
  isToolLifecycleItemType,
  type CanonicalItemType,
  type ItemLifecyclePayload,
} from "@t3tools/contracts";
import { asRecord, asString, type JsonRecord, type RpcEnvelope } from "./protocol.ts";

/** Live RPC frames and persisted native messages share one tool projection. */
export function nativeToolItemPayload(
  raw: RpcEnvelope,
  phase: "started" | "updated" | "completed",
): ItemLifecyclePayload {
  const detail = nativeToolDetail(raw);
  const failed = raw.isError === true || raw.success === false;
  return {
    itemType: canonicalToolItemType(raw),
    status: phase === "completed" ? (failed ? "failed" : "completed") : "inProgress",
    title: canonicalToolTitle(raw),
    ...(detail === undefined ? {} : { detail }),
    data: nativeToolData(raw),
  };
}
const MAX_NATIVE_TOOL_PREVIEW_STRING = 16 * 1024;

function nativeToolName(raw: RpcEnvelope): string | undefined {
  return asString(raw.toolName) ?? asString(raw.name);
}

function nativeToolKey(raw: RpcEnvelope): string {
  return (nativeToolName(raw) ?? "")
    .replace(/^functions[.:/]/i, "")
    .trim()
    .toLowerCase();
}

function canonicalToolItemType(raw: RpcEnvelope): CanonicalItemType {
  const explicit = asString(raw.itemType) ?? asString(raw.item_type);
  if (explicit !== undefined && isToolLifecycleItemType(explicit)) return explicit;

  const key = nativeToolKey(raw);
  if (
    key === "bash" ||
    key === "shell" ||
    key === "terminal" ||
    key === "exec" ||
    key === "exec_command"
  ) {
    return "command_execution";
  }
  if (
    key === "edit" ||
    key === "write" ||
    key === "patch" ||
    key === "apply_patch" ||
    key === "multiedit"
  ) {
    return "file_change";
  }
  if (key === "web_search" || key === "search_web") return "web_search";
  if (key === "inspect_image" || key === "view_image" || key === "image") return "image_view";
  if (
    key === "task" ||
    key === "subagent" ||
    key === "agent" ||
    key === "spawn_agent" ||
    key === "hub"
  ) {
    return "collab_agent_tool_call";
  }
  if (key.startsWith("mcp__")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function titleCaseToolName(value: string): string {
  return value
    .replace(/^functions[.:/]/i, "")
    .replace(/__/g, " · ")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function canonicalToolTitle(raw: RpcEnvelope): string {
  const key = nativeToolKey(raw);
  switch (key) {
    case "read":
      return "Read File";
    case "write":
      return "Write File";
    case "edit":
    case "multiedit":
      return "Edit File";
    case "apply_patch":
    case "patch":
      return "Apply Patch";
    case "bash":
    case "shell":
    case "terminal":
    case "exec":
    case "exec_command":
      return "Terminal";
    case "grep":
      return "Grep";
    case "glob":
      return "Glob";
    case "web_search":
    case "search_web":
      return "Web Search";
    case "inspect_image":
    case "view_image":
    case "image":
      return "View Image";
    case "task":
    case "subagent":
    case "agent":
    case "spawn_agent":
      return "Task";
    case "hub":
      return "Hub";
  }
  return titleCaseToolName(nativeToolName(raw) ?? "") || "Native Tool";
}

function nativeToolOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, MAX_NATIVE_TOOL_PREVIEW_STRING) : undefined;
  }
  const record = asRecord(value);
  const content = record?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed.slice(0, MAX_NATIVE_TOOL_PREVIEW_STRING) : undefined;
  }
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => {
      const entry = asRecord(part);
      const value = asString(entry?.text) ?? asString(entry?.content);
      return value === undefined ? [] : [value];
    })
    .join("\n")
    .trim();
  return text ? text.slice(0, MAX_NATIVE_TOOL_PREVIEW_STRING) : undefined;
}

function nativeToolInput(raw: RpcEnvelope): unknown {
  return raw.args ?? raw.arguments ?? raw.input;
}

function nativeToolResult(raw: RpcEnvelope): unknown {
  return raw.result ?? raw.partialResult ?? raw.output;
}

function nativeToolDetail(raw: RpcEnvelope): string | undefined {
  const intent = asString(raw.intent)?.trim();
  if (intent) return intent;
  const input = asRecord(nativeToolInput(raw));
  const key = nativeToolKey(raw);
  if (
    key === "read" ||
    key === "write" ||
    key === "edit" ||
    key === "multiedit" ||
    key === "inspect_image" ||
    key === "view_image"
  ) {
    return asString(input?.path) ?? asString(input?.filePath);
  }
  if (key === "grep") return asString(input?.pattern) ?? asString(input?.query);
  if (key === "glob") return asString(input?.path) ?? asString(input?.pattern);
  if (key === "web_search" || key === "search_web") return asString(input?.query);
  return undefined;
}

function nativeToolData(raw: RpcEnvelope): JsonRecord {
  const toolCallId = asString(raw.toolCallId) ?? asString(raw.id);
  const name = nativeToolName(raw);
  const input = nativeToolInput(raw);
  const result = nativeToolResult(raw);
  const output = nativeToolOutputText(result);
  const itemType = canonicalToolItemType(raw);
  const item: JsonRecord = {
    type: itemType,
    ...(name === undefined ? {} : { name, toolName: name }),
    ...(input === undefined ? {} : { input }),
    ...(result === undefined ? {} : { result }),
  };
  if (itemType === "command_execution") {
    const command = asString(asRecord(input)?.command);
    if (command !== undefined) item.command = command;
  }
  return {
    ...(toolCallId === undefined ? {} : { toolCallId }),
    kind:
      itemType === "command_execution"
        ? "execute"
        : nativeToolKey(raw) === "read"
          ? "read"
          : nativeToolKey(raw),
    item,
    ...(output === undefined ? {} : { rawOutput: { content: output } }),
  };
}
