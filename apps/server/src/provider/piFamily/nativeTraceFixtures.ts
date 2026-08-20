import type { JsonRecord } from "./protocol.ts";

/** Small synthetic protocol-shaped records for replay coverage; not a private trace capture. */
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
