import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { matchesAppearanceAssetSignature } from "./assetValidation.ts";
import { AppearanceAssetSchema, STRICT_APPEARANCE_PARSE_OPTIONS } from "./schema.ts";
const decodeAppearanceAsset = Schema.decodeUnknownSync(AppearanceAssetSchema);

const bytes = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0));

describe("matchesAppearanceAssetSignature", () => {
  it("accepts each supported bounded signature", () => {
    expect(
      matchesAppearanceAssetSignature(
        "image/png",
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe(true);
    expect(matchesAppearanceAssetSignature("image/jpeg", Uint8Array.of(0xff, 0xd8, 0xff))).toBe(
      true,
    );
    expect(matchesAppearanceAssetSignature("image/webp", bytes("RIFF0000WEBP"))).toBe(true);
    expect(matchesAppearanceAssetSignature("image/avif", bytes("0000ftypavif"))).toBe(true);
    expect(matchesAppearanceAssetSignature("font/woff2", bytes("wOF2"))).toBe(true);
  });

  it("rejects content that does not match its declared MIME type", () => {
    const arbitrary = bytes("not-the-declared-format");
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/avif",
      "font/woff2",
    ] as const) {
      expect(matchesAppearanceAssetSignature(mimeType, arbitrary)).toBe(false);
    }
  });
});

describe("AppearanceAssetSchema", () => {
  const base = {
    id: "asset",
    path: "assets/file.bin",
    sha256: "a".repeat(64),
    sizeBytes: 4,
    platforms: ["web"],
  } as const;

  it("binds font and image kinds to their MIME and metadata contracts", () => {
    expect(() =>
      decodeAppearanceAsset(
        { ...base, kind: "font", mimeType: "image/png", family: "Example" },
        STRICT_APPEARANCE_PARSE_OPTIONS,
      ),
    ).toThrow();
    expect(() =>
      decodeAppearanceAsset(
        { ...base, kind: "image", mimeType: "font/woff2" },
        STRICT_APPEARANCE_PARSE_OPTIONS,
      ),
    ).toThrow();
    expect(() =>
      decodeAppearanceAsset(
        { ...base, kind: "font", mimeType: "font/woff2" },
        STRICT_APPEARANCE_PARSE_OPTIONS,
      ),
    ).toThrow();
  });
});
