import type { JsonRecord } from "./protocol.ts";
/**
 * Structurally scrubbed native captures. Source logs are intentionally not
 * committed because they contain user text, signatures, model metadata, and
 * native session paths. Their hashes bind these public records to the reviewed
 * local captures; IDs and free text below are deterministic replacements.
 */
export const nativeTraceProvenance = {
  pi: {
    runtimeRevision: "efe4d005317e69b3f822694d97f10453903a5069",
    capturedAt: "2026-08-20T21:16:35Z",
    sourceSha256: "b653edca8d7d8085c61b9a04b22959c73ee9526ccb365bdaedbe7cea4d6f3eb9",
    redaction: "Removed user/model/signature/usage data; replaced IDs and assistant text.",
  },
  omp: {
    runtimeRevision: "f5493537f8620de6748876ab8a61706c1dbc1d38",
    capturedAt: "2026-08-20T21:11:31Z/2026-08-20T21:41:57Z",
    sourceSha256: [
      "f93b26052150867476763dd8a8f703764d786458425dff14ce2690da0afc8e77",
      "8c04b732edceaba784612aa7a4c7410ff1a083c086b10e537e4ee993337450b8",
    ],
    redaction:
      "Combined root-turn and task captures; removed prompts, results, paths, signatures, usage, and model metadata; replaced IDs.",
  },
} as const;

export const piRecordedNativeTrace: readonly JsonRecord[] = [
  {
    type: "prompt_result",
    id: "pi-recorded-request",
    accepted: true,
    agentInvoked: true,
    outcome: "started",
  },
  { type: "agent_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 1 },
  },
  {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 1,
      content: "[assistant text]",
    },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "[assistant text]" }],
      stopReason: "stop",
    },
  },
  {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "[assistant text]" }],
      stopReason: "stop",
    },
    toolResults: [],
  },
];

export const ompRecordedNativeTrace: readonly JsonRecord[] = [
  {
    type: "extension_ui_request",
    id: "omp-recorded-widget",
    method: "setWidget",
    widgetKey: "autoresearch",
  },
  { type: "agent_start" },
  {
    type: "tool_execution_start",
    toolCallId: "omp-recorded-task-call",
    toolName: "task",
    args: { context: "[redacted]", tasks: "[redacted]" },
    intent: "Run one child task",
  },
  {
    type: "subagent_lifecycle",
    payload: {
      id: "RecordedChild",
      agent: "sonic",
      runId: "RecordedChild:run-1",
      parentToolCallId: "omp-recorded-task-call",
      detached: true,
      agentSource: "bundled",
      description: "Recorded child task",
      status: "started",
      index: 0,
      parentId: "Main",
    },
  },
  {
    type: "tool_execution_end",
    toolCallId: "omp-recorded-task-call",
    toolName: "task",
    result: { content: "[redacted]", details: "[redacted]" },
    isError: false,
  },
  {
    type: "subagent_lifecycle",
    payload: {
      id: "RecordedChild",
      agent: "sonic",
      runId: "RecordedChild:run-1",
      parentToolCallId: "omp-recorded-task-call",
      detached: true,
      agentSource: "bundled",
      description: "Recorded child task",
      status: "completed",
      index: 0,
      parentId: "Main",
    },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "[assistant text]" }],
      stopReason: "stop",
    },
  },
  { type: "agent_end", isTerminal: true },
];

/** Deterministic edge-case matrix supplement; parity evidence uses the recorded traces above. */
export const piNativeTrace: readonly JsonRecord[] = [
  {
    type: "turn_start",
    eventId: "pi-turn-start",
    requestId: "pi-request",
  },
  {
    type: "message_update",
    eventId: "pi-message-delta-1",
    assistantMessageEvent: { type: "text_delta", delta: "Hello " },
  },
  {
    type: "message_update",
    eventId: "pi-message-delta-2",
    assistantMessageEvent: { type: "text_delta", delta: "πi" },
  },
  {
    type: "tool_execution_start",
    eventId: "pi-tool-start",
    toolCallId: "pi-tool-call",
    toolName: "check",
  },
  {
    type: "tool_execution_update",
    eventId: "pi-tool-progress",
    toolCallId: "pi-tool-call",
    toolName: "check",
  },
  {
    type: "tool_execution_end",
    eventId: "pi-tool-end",
    toolCallId: "pi-tool-call",
    toolName: "check",
  },
  {
    type: "host_task_started",
    eventId: "pi-parent-start",
    task: {
      id: "pi-parent",
      kind: "workflow",
      title: "pi-parent",
      toolCallId: "pi-spawn",
      status: "running",
    },
  },
  {
    type: "host_task_started",
    eventId: "pi-child-start",
    task: {
      id: "pi-child",
      kind: "job",
      title: "pi-child",
      parentToolCallId: "pi-spawn",
      status: "running",
    },
  },
  {
    type: "host_task_progress",
    eventId: "pi-child-progress",
    task: {
      id: "pi-child",
      status: "running",
      summary: "working",
    },
  },
  {
    type: "host_task_completed",
    eventId: "pi-parent-hold",
    task: {
      id: "pi-parent",
      status: "completed",
    },
  },
  {
    type: "host_task_completed",
    eventId: "pi-child-end",
    task: {
      id: "pi-child",
      status: "completed",
      summary: "done",
    },
  },
  { type: "compaction_start", eventId: "pi-compaction-start" },
  { type: "compaction_end", eventId: "pi-compaction-end" },
  { type: "retry_start", eventId: "pi-retry-start" },
  { type: "retry_end", eventId: "pi-retry-end" },
  {
    type: "future_pi_event",
    eventId: "pi-future",
    payload: { marker: "retained" },
  },
  {
    type: "message_end",
    eventId: "pi-message-end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello πi" }],
      stopReason: "stop",
    },
  },
  {
    type: "agent_end",
    eventId: "pi-agent-end",
    requestId: "pi-request",
    isTerminal: true,
  },
];

export const ompNativeTrace: readonly JsonRecord[] = [
  { type: "agent_start", eventId: "omp-agent-start", requestId: "omp-request" },
  {
    type: "message_update",
    eventId: "omp-message-delta-1",
    delta: { text: "Hello " },
  },
  {
    type: "message_update",
    eventId: "omp-message-delta-2",
    delta: { text: "OMP" },
  },
  {
    type: "tool_execution_start",
    eventId: "omp-tool-start",
    toolCallId: "omp-tool-call",
    toolName: "check",
  },
  {
    type: "tool_execution_update",
    eventId: "omp-tool-progress",
    toolCallId: "omp-tool-call",
    toolName: "check",
  },
  {
    type: "tool_execution_end",
    eventId: "omp-tool-end",
    toolCallId: "omp-tool-call",
    toolName: "check",
  },
  {
    type: "subagent_lifecycle",
    eventId: "omp-parent-start",
    id: "omp-parent",
    kind: "workflow",
    title: "omp-parent",
    toolCallId: "omp-spawn",
    status: "running",
  },
  {
    type: "subagent_lifecycle",
    eventId: "omp-child-start",
    id: "omp-child",
    kind: "job",
    title: "omp-child",
    parentToolCallId: "omp-spawn",
    status: "running",
  },
  {
    type: "subagent_progress",
    eventId: "omp-child-progress",
    id: "omp-child",
    status: "running",
    summary: "working",
  },
  {
    type: "subagent_lifecycle",
    eventId: "omp-parent-hold",
    id: "omp-parent",
    status: "completed",
  },
  {
    type: "subagent_lifecycle",
    eventId: "omp-child-end",
    id: "omp-child",
    status: "completed",
    summary: "done",
  },
  { type: "auto_compaction_start", eventId: "omp-compaction-start" },
  { type: "auto_compaction_end", eventId: "omp-compaction-end" },
  { type: "auto_retry_start", eventId: "omp-retry-start" },
  { type: "auto_retry_end", eventId: "omp-retry-end" },
  {
    type: "future_omp_event",
    eventId: "omp-future",
    payload: { marker: "retained" },
  },
  {
    type: "message_end",
    eventId: "omp-message-end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello OMP" }],
      stopReason: "stop",
    },
  },
  {
    type: "agent_end",
    eventId: "omp-agent-end",
    requestId: "omp-request",
    isTerminal: true,
  },
];

function toJsonl(records: readonly JsonRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function chunkRecord(record: JsonRecord, index: number): JsonRecord[] {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  const split = Math.ceil(bytes.byteLength / 2);
  return [0, 1].map((chunkIndex) => {
    const chunk = bytes.subarray(
      chunkIndex === 0 ? 0 : split,
      chunkIndex === 0 ? split : undefined,
    );
    return {
      type: "rpc_chunk",
      chunkId: `omp-trace-${index}`,
      index: chunkIndex,
      count: 2,
      byteLength: bytes.byteLength,
      data: encodeBase64(chunk),
    };
  });
}

export const piNativeTraceJsonl = toJsonl(piNativeTrace);
export const ompNativeChunkedTraceJsonl = toJsonl(
  ompNativeTrace.flatMap((record, index) => chunkRecord(record, index)),
);

export const piRecordedNativeTraceJsonl = toJsonl(piRecordedNativeTrace);
export const ompRecordedNativeChunkedTraceJsonl = toJsonl(
  ompRecordedNativeTrace.flatMap((record, index) => chunkRecord(record, index)),
);
