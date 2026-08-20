import { assert, describe, it } from "vite-plus/test";

import {
  OMP_CHUNK_PAYLOAD_BYTES,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
  OmpChunkAssembler,
} from "./OmpChunkAssembler.ts";
import { PiFamilyProtocolError } from "./protocol.ts";

function expectProtocolError(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    assert.strictEqual(error instanceof PiFamilyProtocolError, true);
    if (error instanceof PiFamilyProtocolError) assert.strictEqual(error.code, code);
    return;
  }
  throw new Error(`Expected protocol error ${code}`);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

function chunkFrames(value: object): Record<string, unknown>[] {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const frames: Record<string, unknown>[] = [];
  const count = Math.ceil(bytes.byteLength / OMP_CHUNK_PAYLOAD_BYTES);
  for (let index = 0; index < count; index += 1) {
    frames.push({
      type: "rpc_chunk",
      chunkId: "rpc-test",
      index,
      count,
      byteLength: bytes.byteLength,
      data: encodeBase64(
        bytes.subarray(index * OMP_CHUNK_PAYLOAD_BYTES, (index + 1) * OMP_CHUNK_PAYLOAD_BYTES),
      ),
    });
  }
  return frames;
}

describe("OmpChunkAssembler", () => {
  it("reassembles the documented base64 UTF-8 object without replacement decoding", () => {
    const original = { type: "message_end", message: `π${"x".repeat(OMP_MAX_FRAME_BYTES)}` };
    const frames = chunkFrames(original);
    assert.isAtLeast(frames.length, 2);
    const assembler = new OmpChunkAssembler();
    for (const [index, frame] of frames.entries()) {
      const result = assembler.accept(frame);
      if (index < frames.length - 1) assert.isUndefined(result);
      else assert.deepEqual(result, original);
    }
    assert.strictEqual(assembler.pendingMessageCount, 0);
  });
  it("accepts a chunked frame smaller than the single-frame limit", () => {
    const original = { type: "response", command: "get_state", value: "small" };
    const bytes = new TextEncoder().encode(JSON.stringify(original));
    const split = Math.ceil(bytes.byteLength / 2);
    const frames = [bytes.subarray(0, split), bytes.subarray(split)].map((chunk, index) => ({
      type: "rpc_chunk",
      chunkId: "small-rpc-test",
      index,
      count: 2,
      byteLength: bytes.byteLength,
      data: encodeBase64(chunk),
    }));
    const assembler = new OmpChunkAssembler();
    assert.isUndefined(assembler.accept(frames[0]));
    assert.deepEqual(assembler.accept(frames[1]), original);
  });

  it("rejects interrupted, reordered, and identity-mismatched sequences", () => {
    const frames = chunkFrames({
      type: "response",
      command: "get_state",
      success: true,
      value: "x".repeat(OMP_MAX_FRAME_BYTES),
    });
    const assembler = new OmpChunkAssembler();
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "rpc-test",
          index: 1,
          count: frames.length,
          byteLength: frames[0]!.byteLength,
          data: frames[0]!.data,
        }),
      "OMP_CHUNK_START",
    );
    assembler.accept(frames[0]!);
    expectProtocolError(() => assembler.accept({ ...frames[1]!, index: 2 }), "OMP_CHUNK_SEQUENCE");
  });

  it("enforces metadata, decoded payload, and total-size limits", () => {
    const assembler = new OmpChunkAssembler();
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "x",
          index: 0,
          count: 2,
          byteLength: OMP_MAX_FRAME_BYTES,
          data: "not-base64",
        }),
      "OMP_CHUNK_DATA",
    );
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "x",
          index: 0,
          count: 1,
          byteLength: OMP_MAX_FRAME_BYTES,
          data: "eA==",
        }),
      "OMP_CHUNK_METADATA",
    );
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "x",
          index: 0,
          count: 2,
          byteLength: OMP_MAX_REASSEMBLED_BYTES + 1,
          data: "eA==",
        }),
      "OMP_CHUNK_METADATA",
    );
  });
  it("enforces the configured reassembled-message limit", () => {
    const assembler = new OmpChunkAssembler(4);
    expectProtocolError(
      () =>
        assembler.accept({
          type: "rpc_chunk",
          chunkId: "limited",
          index: 0,
          count: 2,
          byteLength: 5,
          data: encodeBase64(new Uint8Array([1])),
        }),
      "OMP_CHUNK_METADATA",
    );
  });
});
