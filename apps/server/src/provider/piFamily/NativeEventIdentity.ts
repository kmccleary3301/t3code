import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";

import { asNumber, asString, type PiFamilyRuntimeKind, type RpcEnvelope } from "./protocol.ts";

const MAX_NATIVE_IDENTITY_PART_LENGTH = 128;

function boundedNativeIdentityPart(value: string): string {
  if (value.length <= MAX_NATIVE_IDENTITY_PART_LENGTH) return value;
  const digest = NodeCrypto.createHash("sha256").update(value).digest("hex");
  return `${value.slice(0, 32)}~${digest}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Returns a restart-stable identity for a native event. Explicit native
 * sequence/event ids win. Otherwise the canonical frame is the deterministic
 * identity and a per-identical-frame occurrence disambiguates repeated chunks
 * without coupling unique frames to unrelated prior traffic.
 */
export function nativeEventId(
  runtime: PiFamilyRuntimeKind,
  event: RpcEnvelope,
  occurrence?: number,
): string {
  const eventType = boundedNativeIdentityPart(event.type);
  const explicit =
    asString(event.eventId) ??
    asString(event.event_id) ??
    (asNumber(event.sequence) ?? asNumber(event.seq))?.toString() ??
    asString(event.id);
  if (explicit !== undefined) {
    return `${runtime}:${eventType}:${boundedNativeIdentityPart(explicit)}`;
  }
  let hash = 2_166_261;
  for (const character of stableJson(event))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  const fallback = `${runtime}:${eventType}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  return occurrence === undefined ? fallback : `${fallback}:seq:${occurrence}`;
}

let idCounter = 0;

/** Returns the process-local monotonic id used for non-native runtime events. */
export const nextNativeId = (): string =>
  `${DateTime.nowUnsafe().epochMilliseconds.toString(36)}-${(idCounter++).toString(36)}`;
