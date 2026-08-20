/**
 * Wire-neutral contracts for the native Pi and Oh My Pi RPC dialects.
 *
 * The native processes own models, commands, sessions, tasks, and extensions.
 * This module only describes what T3 may observe and preserve at the provider
 * boundary; it does not invent commands for either runtime.
 */

export type PiFamilyRuntimeKind = "pi" | "omp";

export type JsonRecord = Record<string, unknown>;

export interface RpcEnvelope extends JsonRecord {
  readonly type: string;
  readonly id?: string;
}

/** Pi and OMP both use this response envelope, but their command unions differ. */
export interface RpcResponse extends RpcEnvelope {
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly data?: unknown;
}

/** A native event is intentionally open: unknown events are retained verbatim. */
export interface RpcEvent extends RpcEnvelope {}

export type PiRpcFrame = RpcResponse | RpcEvent;

export interface OmpReadyFrame extends RpcEnvelope {
  readonly type: "ready";
  readonly protocolVersion: 1;
  readonly supportedProtocolVersions: readonly [1, 2];
  readonly maxFrameBytes: 1_048_576;
  readonly maxReassembledFrameBytes: 67_108_864;
}

export interface OmpNegotiateProtocolCommand extends RpcEnvelope {
  readonly type: "negotiate_protocol";
  readonly protocolVersion: 2;
}

export interface OmpNegotiateProtocolResponse extends RpcResponse {
  readonly command: "negotiate_protocol";
  readonly success: true;
  readonly data: { readonly protocolVersion: 2 };
}

export interface OmpRpcChunkFrame extends JsonRecord {
  readonly type: "rpc_chunk";
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  /** Base64 bytes from the original UTF-8 JSON object. */
  readonly data: string;
}

export interface PiFamilyLaunchConfig {
  readonly runtime: PiFamilyRuntimeKind;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly agentDirectory?: string;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly maxMessageBytes?: number;
  readonly stderrLimitBytes?: number;
}

export interface RuntimeCapabilities {
  readonly runtime: PiFamilyRuntimeKind;
  readonly runtimeVersion?: string;
  /** Pi is always v1 and has no negotiation frame. OMP starts at v1. */
  readonly protocolVersion: 1 | 2;
  readonly supportedProtocolVersions: readonly (1 | 2)[];
  readonly negotiatedProtocolVersion?: 2;
  readonly transport: {
    readonly strictLfJsonl: true;
    readonly maxFrameBytes?: number;
    readonly maxReassembledFrameBytes?: number;
    readonly chunking: boolean;
  };
  readonly models: { readonly discover: boolean; readonly switch: boolean };
  readonly thinking: { readonly discover: boolean; readonly switch: boolean };
  readonly commands: { readonly discover: boolean; readonly invokeNative: boolean };
  readonly sessions: {
    readonly resume: boolean;
    readonly tree: boolean;
    readonly fork: boolean;
    readonly compact: boolean;
    readonly nativeCheckpoint: boolean;
    readonly completeTurnRollback: boolean;
  };
  readonly ui: {
    readonly select: boolean;
    readonly confirm: boolean;
    readonly input: boolean;
    readonly editor: boolean;
    readonly notify: boolean;
    readonly status: boolean;
    readonly widget: boolean;
    readonly openUrl: boolean;
    readonly arbitraryTerminalComponents: false;
  };
  readonly tasks: {
    readonly lifecycle: boolean;
    readonly nested: boolean;
    readonly childTranscript: boolean;
    readonly workflows: boolean;
    readonly background: boolean;
    readonly targetedCancellation: boolean;
  };
  /** Provider-owned capability payload, never interpreted by T3. */
  readonly raw?: JsonRecord;
}

/** Construct an absence-safe capability set before native discovery exists. */
export function absentRuntimeCapabilities(runtime: PiFamilyRuntimeKind): RuntimeCapabilities {
  const omp = runtime === "omp";
  return {
    runtime,
    protocolVersion: 1,
    supportedProtocolVersions: omp ? [1, 2] : [1],
    transport: {
      strictLfJsonl: true,
      ...(omp ? { maxFrameBytes: 1_048_576, maxReassembledFrameBytes: 67_108_864 } : {}),
      chunking: omp,
    },
    models: { discover: false, switch: false },
    thinking: { discover: false, switch: false },
    commands: { discover: false, invokeNative: false },
    sessions: {
      resume: false,
      tree: false,
      fork: false,
      compact: false,
      nativeCheckpoint: false,
      completeTurnRollback: false,
    },
    ui: {
      select: false,
      confirm: false,
      input: false,
      editor: false,
      notify: false,
      status: false,
      widget: false,
      openUrl: false,
      arbitraryTerminalComponents: false,
    },
    tasks: {
      lifecycle: false,
      nested: false,
      childTranscript: false,
      workflows: false,
      background: false,
      targetedCancellation: false,
    },
  };
}

export interface NativeCheckpoint {
  readonly runtime: PiFamilyRuntimeKind;
  readonly runtimeVersion?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly leafEntryId?: string;
  readonly sequence?: number;
  /** Native checkpoint payload is opaque to T3 and must round-trip unchanged. */
  readonly opaque: unknown;
}

export type PortableUiRequest =
  | {
      readonly kind: "select";
      readonly requestId: string;
      readonly title?: string;
      readonly message?: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
      readonly allowCancel?: boolean;
    }
  | {
      readonly kind: "confirm";
      readonly requestId: string;
      readonly title?: string;
      readonly message: string;
      readonly confirmLabel?: string;
      readonly cancelLabel?: string;
    }
  | {
      readonly kind: "input" | "editor";
      readonly requestId: string;
      readonly title?: string;
      readonly message?: string;
      readonly initialValue?: string;
      readonly placeholder?: string;
    }
  | {
      readonly kind: "notify";
      readonly requestId?: string;
      readonly message: string;
      readonly level?: "info" | "success" | "warning" | "error";
    }
  | {
      readonly kind: "status";
      readonly requestId?: string;
      readonly key: string;
      readonly value?: string;
    }
  | {
      readonly kind: "widget";
      readonly requestId?: string;
      readonly key: string;
      readonly content?: string;
      readonly placement?: "above" | "below";
    }
  | {
      readonly kind: "open_url";
      readonly requestId?: string;
      readonly url: string;
      readonly purpose?: "authentication" | "documentation" | "external";
    }
  | {
      readonly kind: "unsupported_terminal_ui";
      readonly requestId?: string;
      readonly feature: string;
      readonly message: string;
    };

export type PortableUiResponse =
  | { readonly requestId: string; readonly cancelled: true }
  | {
      readonly requestId: string;
      readonly cancelled?: false;
      readonly value: string | boolean | null;
    };

export type CanonicalTaskStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface NativeTaskIdentity {
  readonly id: string;
  readonly parentTaskId?: string;
  readonly parentToolCallId?: string;
  readonly kind: string;
  readonly title: string;
  readonly role?: string;
}

export interface NativeTaskRunHandles {
  readonly sessionFile?: string;
  readonly transcript?: string;
  readonly outputPath?: string;
  readonly patchPath?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly jobId?: string;
  readonly [key: string]: unknown;
}

export interface NativeTaskSnapshot extends NativeTaskIdentity {
  readonly status: CanonicalTaskStatus;
  readonly description?: string;
  readonly currentActivity?: string;
  readonly lastToolName?: string;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly attempt?: number;
  readonly workflow?: {
    readonly name?: string;
    readonly phaseIndex?: number;
    readonly phaseTitle?: string;
    readonly agentIndex?: number;
  };
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly contextTokens?: number;
    readonly costUsd?: number;
    readonly durationMs?: number;
    readonly toolCalls?: number;
  };
  readonly runHandles?: NativeTaskRunHandles;
  readonly summary?: string;
  readonly error?: string;
  readonly detached?: boolean;
  readonly metadata?: JsonRecord;
}

export type PiFamilyProjectedEvent =
  | { readonly kind: "runtime.ready"; readonly ready: OmpReadyFrame }
  | {
      readonly kind: "runtime.exit";
      readonly code: number | null;
      readonly signal: string | null;
      readonly stderr: string;
    }
  | { readonly kind: "runtime.error"; readonly error: Error; readonly raw?: unknown }
  | { readonly kind: "runtime.raw"; readonly event: RpcEnvelope }
  | { readonly kind: "turn.started"; readonly requestId?: string; readonly raw: RpcEnvelope }
  | { readonly kind: "turn.settled"; readonly requestId?: string; readonly raw: RpcEnvelope }
  | {
      readonly kind: "message.delta";
      readonly channel: "assistant" | "reasoning";
      readonly text: string;
      readonly raw: RpcEnvelope;
    }
  | { readonly kind: "message.completed"; readonly raw: RpcEnvelope }
  | {
      readonly kind: "tool.started" | "tool.progress" | "tool.completed";
      readonly toolCallId?: string;
      readonly name?: string;
      readonly raw: RpcEnvelope;
    }
  | {
      readonly kind: "task.started" | "task.progress" | "task.completed";
      readonly task: NativeTaskSnapshot;
      readonly raw: RpcEnvelope;
    }
  | { readonly kind: "ui.request"; readonly request: PortableUiRequest; readonly raw: RpcEnvelope }
  | {
      readonly kind:
        | "queue.changed"
        | "compaction.started"
        | "compaction.completed"
        | "retry.scheduled";
      readonly raw: RpcEnvelope;
    };

export class PiFamilyProtocolError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  public constructor(message: string, code = "PI_FAMILY_PROTOCOL_ERROR", details?: unknown) {
    super(message);
    this.name = "PiFamilyProtocolError";
    this.code = code;
    this.details = details;
  }
}

export function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  const record = asRecord(value);
  return (
    record?.type === "response" &&
    typeof record.command === "string" &&
    typeof record.success === "boolean"
  );
}

export function parseJsonObject(value: string): RpcEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new PiFamilyProtocolError("RPC frame was not valid JSON", "RPC_INVALID_JSON", { cause });
  }
  const record = asRecord(parsed);
  if (!record || typeof record.type !== "string") {
    throw new PiFamilyProtocolError(
      "RPC frame must be an object with a string type",
      "RPC_INVALID_FRAME",
      parsed,
    );
  }
  return record as RpcEnvelope;
}

export function validateOmpReadyFrame(value: unknown): OmpReadyFrame {
  const record = asRecord(value);
  const versions = record?.supportedProtocolVersions;
  if (
    record?.type !== "ready" ||
    record.protocolVersion !== 1 ||
    !Array.isArray(versions) ||
    versions.length !== 2 ||
    versions[0] !== 1 ||
    versions[1] !== 2 ||
    record.maxFrameBytes !== 1_048_576 ||
    record.maxReassembledFrameBytes !== 67_108_864
  ) {
    throw new PiFamilyProtocolError("Malformed OMP ready frame", "OMP_READY_MALFORMED", value);
  }
  return record as unknown as OmpReadyFrame;
}

export function makeOmpNegotiateProtocolCommand(id: string): OmpNegotiateProtocolCommand {
  if (id.length === 0)
    throw new PiFamilyProtocolError("OMP negotiation id must not be empty", "OMP_NEGOTIATION_ID");
  return { id, type: "negotiate_protocol", protocolVersion: 2 };
}

export function validateOmpNegotiateProtocolResponse(value: unknown): OmpNegotiateProtocolResponse {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  if (
    record?.type !== "response" ||
    record.command !== "negotiate_protocol" ||
    record.success !== true ||
    data?.protocolVersion !== 2
  ) {
    throw new PiFamilyProtocolError(
      "OMP protocol v2 negotiation failed",
      "OMP_NEGOTIATION_FAILED",
      value,
    );
  }
  return record as unknown as OmpNegotiateProtocolResponse;
}
