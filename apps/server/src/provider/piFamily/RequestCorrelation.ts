import { PiFamilyProtocolError, type PiFamilyRuntimeKind, type RpcResponse } from "./protocol.ts";

export type RpcRequestLifecycleState =
  | "created"
  | "sent"
  | "accepted"
  | "streaming"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "closed";

export type RpcRequestResponseMode = "immediate" | "deferred";

/**
 * Timeout classes describe which boundary failed. They are deliberately
 * separate from the request lifecycle state so callers can distinguish a
 * startup handshake timeout from an ordinary command timeout.
 */
export type RpcRequestTimeoutClass = "startup" | "request" | "transport";

export type RpcRequestFailureKind =
  | "provider"
  | "timeout"
  | "transport"
  | "protocol"
  | "cancelled"
  | "closed";

export interface RpcRequestFailure {
  readonly kind: RpcRequestFailureKind;
  readonly message: string;
  readonly timeoutClass?: RpcRequestTimeoutClass;
  readonly cause?: unknown;
}

export interface RpcRequestRecord {
  readonly id: string;
  readonly runtime: PiFamilyRuntimeKind;
  readonly command: string;
  readonly responseMode: RpcRequestResponseMode;
  readonly state: RpcRequestLifecycleState;
  readonly createdAt: number;
  readonly sentAt?: number;
  readonly settledAt?: number;
  readonly response?: RpcResponse;
  readonly failure?: RpcRequestFailure;
}

export type RpcRequestCorrelationResult =
  | { readonly matched: true; readonly record: RpcRequestRecord }
  | { readonly matched: false; readonly response: RpcResponse };

const ACTIVE_STATES = new Set<RpcRequestLifecycleState>([
  "created",
  "sent",
  "accepted",
  "streaming",
]);
const TRANSITIONS: Readonly<Record<RpcRequestLifecycleState, readonly RpcRequestLifecycleState[]>> =
  {
    created: ["sent", "cancelled", "failed", "closed"],
    sent: ["accepted", "streaming", "succeeded", "failed", "timed_out", "cancelled", "closed"],
    accepted: ["streaming", "succeeded", "failed", "timed_out", "cancelled", "closed"],
    streaming: ["succeeded", "failed", "timed_out", "cancelled", "closed"],
    succeeded: [],
    failed: [],
    timed_out: [],
    cancelled: [],
    closed: [],
  };

const TIMEOUT_CLASSES = new Set<RpcRequestTimeoutClass>(["startup", "request", "transport"]);

/** In-memory correlation table for one native process/session. */
export class PiFamilyRequestCorrelator {
  private readonly requests = new Map<string, RpcRequestRecord>();
  private readonly now: () => number;

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public register(input: {
    readonly id: string;
    readonly runtime: PiFamilyRuntimeKind;
    readonly command: string;
    readonly responseMode?: RpcRequestResponseMode;
  }): RpcRequestRecord {
    if (input.id.length === 0) {
      throw new PiFamilyProtocolError("RPC request id must not be empty", "RPC_REQUEST_ID");
    }
    if (this.requests.has(input.id)) {
      throw new PiFamilyProtocolError(
        `Duplicate RPC request id: ${input.id}`,
        "RPC_DUPLICATE_REQUEST_ID",
        input.id,
      );
    }
    const record: RpcRequestRecord = {
      id: input.id,
      runtime: input.runtime,
      command: input.command,
      responseMode: input.responseMode ?? "immediate",
      state: "created",
      createdAt: this.now(),
    };
    this.requests.set(input.id, record);
    return record;
  }

  public markSent(id: string): RpcRequestRecord {
    return this.transition(id, "sent", { sentAt: this.now() });
  }

  public markAccepted(id: string): RpcRequestRecord {
    return this.transition(id, "accepted");
  }

  public markStreaming(id: string): RpcRequestRecord {
    return this.transition(id, "streaming");
  }

  public resolve(response: RpcResponse): RpcRequestCorrelationResult {
    const id = response.id;
    if (typeof id !== "string") return { matched: false, response };
    const existing = this.requests.get(id);
    // Terminal records are retained specifically so a response arriving after
    // timeout, cancellation, process crash, or shutdown cannot be reused.
    if (!existing || !ACTIVE_STATES.has(existing.state)) return { matched: false, response };
    if (response.success) {
      return {
        matched: true,
        record: this.transition(id, "succeeded", { response, settledAt: this.now() }),
      };
    }
    return {
      matched: true,
      record: this.transition(id, "failed", {
        response,
        settledAt: this.now(),
        failure: { kind: "provider", message: response.error ?? `RPC request ${id} failed` },
      }),
    };
  }

  /**
   * Record a timeout without forgetting the ID. A late response therefore
   * cannot settle a newer request that happens to use the same wire ID.
   *
   * The second argument accepts the old message-only form for callers that do
   * not need a timeout class.
   */
  public timeout(
    id: string,
    timeoutClassOrMessage: RpcRequestTimeoutClass | string = "request",
    message?: string,
  ): RpcRequestRecord {
    const timeoutClass = TIMEOUT_CLASSES.has(timeoutClassOrMessage as RpcRequestTimeoutClass)
      ? (timeoutClassOrMessage as RpcRequestTimeoutClass)
      : "request";
    const detail =
      timeoutClass === timeoutClassOrMessage
        ? (message ?? `RPC request ${id} timed out`)
        : timeoutClassOrMessage;
    return this.transition(id, "timed_out", {
      settledAt: this.now(),
      failure: { kind: "timeout", message: detail, timeoutClass },
    });
  }

  public fail(id: string, failure: RpcRequestFailure): RpcRequestRecord {
    return this.transition(id, "failed", { settledAt: this.now(), failure });
  }

  public failAll(failure: RpcRequestFailure): RpcRequestRecord[] {
    const failed: RpcRequestRecord[] = [];
    for (const request of this.requests.values()) {
      if (!ACTIVE_STATES.has(request.state)) continue;
      failed.push(this.transition(request.id, "failed", { settledAt: this.now(), failure }));
    }
    return failed;
  }

  public cancel(id: string, message = `RPC request ${id} was cancelled`): RpcRequestRecord {
    return this.transition(id, "cancelled", {
      settledAt: this.now(),
      failure: { kind: "cancelled", message },
    });
  }

  public close(message = "Native RPC session closed"): RpcRequestRecord[] {
    const closed: RpcRequestRecord[] = [];
    for (const request of this.requests.values()) {
      if (!ACTIVE_STATES.has(request.state)) continue;
      closed.push(
        this.transition(request.id, "closed", {
          settledAt: this.now(),
          failure: { kind: "closed", message },
        }),
      );
    }
    return closed;
  }

  public get(id: string): RpcRequestRecord | undefined {
    return this.requests.get(id);
  }

  public pending(): RpcRequestRecord[] {
    return [...this.requests.values()].filter((request) => ACTIVE_STATES.has(request.state));
  }

  private transition(
    id: string,
    state: RpcRequestLifecycleState,
    patch: Partial<
      Omit<RpcRequestRecord, "id" | "runtime" | "command" | "responseMode" | "state" | "createdAt">
    > = {},
  ): RpcRequestRecord {
    const current = this.requests.get(id);
    if (!current)
      throw new PiFamilyProtocolError(
        `Unknown RPC request id: ${id}`,
        "RPC_UNKNOWN_REQUEST_ID",
        id,
      );
    if (!TRANSITIONS[current.state].includes(state)) {
      throw new PiFamilyProtocolError(
        `Invalid RPC request transition ${current.state} -> ${state}`,
        "RPC_INVALID_REQUEST_TRANSITION",
        { id, current: current.state, next: state },
      );
    }
    const next: RpcRequestRecord = { ...current, ...patch, state };
    this.requests.set(id, next);
    return next;
  }
}
