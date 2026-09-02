import { describe, expect, it } from "vite-plus/test";
import { appearanceBytesSha256 } from "@t3tools/shared/appearance";

import { AppearanceAssetRegistry } from "./appearanceAssetRegistry";

const storedBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const stored = {
  assets: [
    {
      id: "logo",
      path: "images/logo.png",
      sha256: appearanceBytesSha256(storedBytes),
      mimeType: "image/png" as const,
      sizeBytes: storedBytes.byteLength,
      dataBase64: "iVBORw0KGgo=",
    },
  ],
};

describe("AppearanceAssetRegistry", () => {
  it("deduplicates object URLs and revokes after the last artifact releases them", () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const registry = new AppearanceAssetRegistry({
      create: (blob) => {
        created.push(blob);
        return `blob:appearance-${created.length}`;
      },
      revoke: (url) => revoked.push(url),
    });
    const first = registry.acquire(stored);
    const second = registry.acquire(stored);

    expect(first.resolve("images/logo.png")).toBe("blob:appearance-1");
    expect(first.resolve("images/logo.png")).toBe("blob:appearance-1");
    expect(second.resolve("images/logo.png")).toBe("blob:appearance-1");
    expect(first.resolve("images/missing.png")).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("image/png");

    first.dispose();
    expect(revoked).toEqual([]);
    expect(first.resolve("images/logo.png")).toBeNull();
    second.dispose();
    second.dispose();
    expect(revoked).toEqual(["blob:appearance-1"]);
  });

  it("rejects checksum and MIME signature confusion before Blob creation", () => {
    let created = 0;
    const registry = new AppearanceAssetRegistry({
      create: () => {
        created += 1;
        return "blob:unexpected";
      },
      revoke: () => undefined,
    });
    const badHash = {
      assets: [{ ...stored.assets[0]!, sha256: "0".repeat(64) }],
    };
    const badSignature = {
      assets: [{ ...stored.assets[0]!, mimeType: "image/jpeg" as const }],
    };
    expect(registry.acquire(badHash).resolve("images/logo.png")).toBeNull();
    expect(registry.acquire(badSignature).resolve("images/logo.png")).toBeNull();
    expect(created).toBe(0);
  });
});
