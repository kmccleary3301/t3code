import { assert, describe, it } from "vite-plus/test";

import { PiFamilyProtocolError } from "./protocol.ts";
import { StrictJsonlDecoder } from "./StrictJsonlDecoder.ts";

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
describe("StrictJsonlDecoder", () => {
  it("splits only LF and preserves fragmented UTF-8 and Unicode separators", () => {
    const value = JSON.stringify({ text: "before\u2028after 🚀" });
    const bytes = new TextEncoder().encode(`${value}\n{"type":"second"}\r\n`);
    const decoder = new StrictJsonlDecoder(1024);
    const emojiOffset = bytes.indexOf(0xf0);
    const first = decoder.push(bytes.subarray(0, emojiOffset + 2));
    assert.deepEqual(first, []);
    const second = decoder.push(bytes.subarray(emojiOffset + 2, emojiOffset + 3));
    assert.deepEqual(second, []);
    const lines = decoder.push(bytes.subarray(emojiOffset + 3));
    assert.deepEqual(lines, [value, '{"type":"second"}']);
  });

  it("decodes an unterminated final record only at finish", () => {
    const decoder = new StrictJsonlDecoder(1024);
    assert.deepEqual(decoder.push('{"type":"tail"}'), []);
    assert.deepEqual(decoder.finish(), ['{"type":"tail"}']);
    assert.deepEqual(decoder.finish(), []);
  });

  it("rejects malformed UTF-8 instead of replacing bytes", () => {
    const decoder = new StrictJsonlDecoder(1024);
    expectProtocolError(
      () => decoder.push(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a])),
      "RPC_INVALID_UTF8",
    );
  });

  it("bounds an unterminated physical frame", () => {
    const decoder = new StrictJsonlDecoder(4);
    expectProtocolError(
      () => decoder.push(new TextEncoder().encode("12345")),
      "RPC_LINE_TOO_LARGE",
    );
  });
});
