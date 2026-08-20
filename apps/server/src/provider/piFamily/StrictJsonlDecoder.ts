import { PiFamilyProtocolError } from "./protocol.ts";

/**
 * Strict LF-framed decoder for both native RPC dialects.
 *
 * Delimiters are found in bytes, not decoded text. This preserves Unicode line
 * separators inside JSON strings and allows a multibyte UTF-8 sequence to be
 * split across input chunks. UTF-8 is decoded once a complete record exists,
 * with fatal decoding so malformed bytes cannot become replacement characters.
 */
export class StrictJsonlDecoder {
  private pending = new Uint8Array(0);
  private readonly maxLineBytes: number;

  public constructor(maxLineBytes = 1_048_576) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError("maxLineBytes must be a positive safe integer");
    }
    this.maxLineBytes = maxLineBytes;
  }

  public push(chunk: Uint8Array | string): string[] {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    if (bytes.byteLength === 0) return [];

    const combined = new Uint8Array(this.pending.byteLength + bytes.byteLength);
    combined.set(this.pending);
    combined.set(bytes, this.pending.byteLength);
    this.pending = combined;

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = this.pending.indexOf(0x0a, start);
      if (end < 0) break;
      const frame = this.pending.subarray(start, end);
      if (frame.byteLength > this.maxLineBytes) this.throwTooLarge(frame.byteLength);
      lines.push(
        this.decode(
          frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d
            ? frame.subarray(0, frame.byteLength - 1)
            : frame,
        ),
      );
      start = end + 1;
    }

    this.pending = this.pending.slice(start);
    if (this.pending.byteLength > this.maxLineBytes) this.throwTooLarge(this.pending.byteLength);
    return lines;
  }

  /** Decode an unterminated final record, if present. */
  public finish(): string[] {
    if (this.pending.byteLength === 0) return [];
    if (this.pending.byteLength > this.maxLineBytes) this.throwTooLarge(this.pending.byteLength);
    const frame = this.pending;
    this.pending = new Uint8Array(0);
    const withoutCr =
      frame[frame.byteLength - 1] === 0x0d ? frame.subarray(0, frame.byteLength - 1) : frame;
    return [this.decode(withoutCr)];
  }

  public reset(): void {
    this.pending = new Uint8Array(0);
  }

  private decode(bytes: Uint8Array): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new PiFamilyProtocolError("RPC frame contained malformed UTF-8", "RPC_INVALID_UTF8", {
        cause,
      });
    }
  }

  private throwTooLarge(byteLength: number): never {
    throw new PiFamilyProtocolError(
      `RPC frame exceeded ${this.maxLineBytes} bytes without an LF delimiter`,
      "RPC_LINE_TOO_LARGE",
      { byteLength, maxLineBytes: this.maxLineBytes },
    );
  }
}
