import { describe, expect, it } from "@effect/vitest";
import {
  createAppearanceRuntime,
  createEmptyAppearanceState,
  type AppearancePersistedState,
  type AppearanceStorageAdapter,
} from "@t3tools/client-runtime/appearance";
import { appearanceBytesSha256, normalizeAppearance } from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import JSZip from "jszip";

import { compileWebAppearance } from "./appearanceRuntime";
import {
  inspectBrowserAppearancePackage,
  installBrowserAppearancePackage,
  parseAppearanceSnippetBundle,
  serializeAppearanceSnippetBundle,
  serializeBrowserAppearancePackage,
} from "./browserAppearancePackages";

class MemoryStorage implements AppearanceStorageAdapter {
  state: AppearancePersistedState = createEmptyAppearanceState();
  load = async () => this.state;
  commit = async (expectedRevision: number, state: AppearancePersistedState) => {
    if (expectedRevision !== this.state.revision) throw new Error("revision conflict");
    this.state = state;
  };
  subscribe = () => () => undefined;
}

async function runtimeWithStorage(storage: MemoryStorage) {
  return createAppearanceRuntime({
    storage,
    compiler: {
      normalize: (input, options) => normalizeAppearance(input, options),
      compile: async (input) => compileWebAppearance(input),
    },
    apply: { apply: async () => undefined },
  });
}
function forgeZipUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const forged = bytes.slice();
  const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  const endOffset = forged.byteLength - 22;
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const localOffset = view.getUint32(directoryOffset + 42, true);
  view.setUint32(directoryOffset + 24, size, true);
  view.setUint32(localOffset + 22, size, true);
  return forged;
}

describe("browser appearance package workflows", () => {
  it("round-trips an exported package and installs it disabled until activation", async () => {
    const sourceStorage = new MemoryStorage();
    const sourceRuntime = await runtimeWithStorage(sourceStorage);
    await sourceRuntime.execute({
      type: "install",
      package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
      activate: true,
    });
    const stored = sourceStorage.state.packages[T3_CHAT_THEME.id];
    if (stored === undefined) throw new Error("missing fixture package");

    const document = serializeBrowserAppearancePackage(stored);
    const review = await inspectBrowserAppearancePackage(
      "theme.t3appearance.json",
      new TextEncoder().encode(document),
    );
    const destinationStorage = new MemoryStorage();
    const destinationRuntime = await runtimeWithStorage(destinationStorage);
    const result = await installBrowserAppearancePackage(destinationRuntime, review, false);

    expect(result.status).toBe("applied");
    expect(destinationStorage.state.packages[T3_CHAT_THEME.id]?.enabled).toBe(false);
    expect(review.replacing).toBe(false);
  });
  it("rejects JSON assets whose hash matches but MIME signature does not", async () => {
    const sourceStorage = new MemoryStorage();
    const sourceRuntime = await runtimeWithStorage(sourceStorage);
    await sourceRuntime.execute({
      type: "install",
      package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
      activate: true,
    });
    const stored = sourceStorage.state.packages[T3_CHAT_THEME.id];
    if (stored === undefined) throw new Error("missing fixture package");
    const bytes = Uint8Array.from([1, 2]);
    const declaration = {
      id: "logo",
      kind: "image",
      path: "images/logo.png",
      sha256: appearanceBytesSha256(bytes),
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      platforms: ["web"],
    } as const;
    const forged = {
      ...stored,
      manifest: { ...stored.manifest, assets: [declaration] },
      profile: { ...stored.profile, assets: [declaration] },
      assets: [
        {
          id: declaration.id,
          path: declaration.path,
          sha256: declaration.sha256,
          mimeType: declaration.mimeType,
          sizeBytes: declaration.sizeBytes,
          dataBase64: "AQI=",
        },
      ],
    };
    await expect(
      inspectBrowserAppearancePackage(
        "theme.t3appearance.json",
        new TextEncoder().encode(serializeBrowserAppearancePackage(forged)),
      ),
    ).rejects.toThrow("MIME signature");
  });

  it("imports a bounded ZIP and rejects traversal entries", async () => {
    const validZip = new JSZip();
    validZip.file("manifest.json", JSON.stringify(T3_CHAT_THEME));
    const validBytes = await validZip.generateAsync({ type: "uint8array" });
    await expect(inspectBrowserAppearancePackage("theme.zip", validBytes)).resolves.toMatchObject({
      profile: { metadata: { id: T3_CHAT_THEME.id } },
    });

    const unsafeZip = new JSZip();
    unsafeZip.file("../manifest.json", JSON.stringify(T3_CHAT_THEME));
    const unsafeBytes = await unsafeZip.generateAsync({ type: "uint8array" });
    await expect(inspectBrowserAppearancePackage("theme.zip", unsafeBytes)).rejects.toThrow(
      "Unsafe package path",
    );
  });
  it("bounds inflated bytes when ZIP size metadata is forged", async () => {
    const archive = new JSZip();
    archive.file("manifest.json", "x".repeat(1024 * 1024));
    const bytes = await archive.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });

    await expect(
      inspectBrowserAppearancePackage("theme.zip", forgeZipUncompressedSize(bytes, 1)),
    ).rejects.toThrow("expands beyond");
  });

  it("round-trips ordered snippets and rejects duplicate stable IDs", () => {
    const snippets = [
      { id: "first", css: ":root{--one:1}", enabled: true, advanced: false },
      { id: "second", css: ":root{--two:2}", enabled: false, advanced: true },
    ] as const;
    expect(parseAppearanceSnippetBundle(serializeAppearanceSnippetBundle(snippets))).toEqual(
      snippets,
    );
    expect(() =>
      parseAppearanceSnippetBundle(serializeAppearanceSnippetBundle([snippets[0], snippets[0]])),
    ).toThrow("duplicate snippet");
  });
});
