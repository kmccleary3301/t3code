import { describe, expect, it } from "vite-plus/test";

import { AppearanceAssetRegistry } from "./appearanceAssetRegistry";

const stored = {
  assets: [
    {
      id: "logo",
      path: "images/logo.png",
      sha256: "a".repeat(64),
      mimeType: "image/png" as const,
      sizeBytes: 2,
      dataBase64: "AQI=",
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
});
