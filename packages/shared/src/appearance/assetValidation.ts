import type { AppearanceAsset } from "./schema.ts";

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

/** Validate the bounded file signatures accepted by appearance asset decoders. */
export function matchesAppearanceAssetSignature(
  mimeType: AppearanceAsset["mimeType"],
  bytes: Uint8Array,
): boolean {
  switch (mimeType) {
    case "image/png":
      return (
        bytes.byteLength >= 8 &&
        bytes[0] === 0x89 &&
        ascii(bytes, 1, "PNG") &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "image/jpeg":
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return bytes.byteLength >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP");
    case "image/avif": {
      if (bytes.byteLength < 12 || !ascii(bytes, 4, "ftyp")) return false;
      for (let offset = 8; offset + 4 <= Math.min(bytes.byteLength, 64); offset += 4) {
        if (ascii(bytes, offset, "avif") || ascii(bytes, offset, "avis")) return true;
      }
      return false;
    }
    case "font/woff2":
      return bytes.byteLength >= 4 && ascii(bytes, 0, "wOF2");
  }
}
