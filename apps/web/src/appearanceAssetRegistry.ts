import type { AppearanceStoredPackage } from "@t3tools/client-runtime/appearance";

import { appearanceBytesSha256, matchesAppearanceAssetSignature } from "@t3tools/shared/appearance";

export interface AppearanceObjectUrlApi {
  readonly create: (value: Blob) => string;
  readonly revoke: (url: string) => void;
}

export interface AppearanceAssetLease {
  readonly resolve: (path: string) => string | null;
  readonly dispose: () => void;
}

type CachedUrl = {
  readonly url: string;
  references: number;
};

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function nativeObjectUrls(): AppearanceObjectUrlApi {
  return {
    create: (value) => URL.createObjectURL(value),
    revoke: (url) => URL.revokeObjectURL(url),
  };
}

/** Ref-counted object URLs scoped to compiled appearance artifacts. */
export class AppearanceAssetRegistry {
  readonly #urls: AppearanceObjectUrlApi;
  readonly #cache = new Map<string, CachedUrl>();

  constructor(urls: AppearanceObjectUrlApi = nativeObjectUrls()) {
    this.#urls = urls;
  }

  acquire(packageValue: Pick<AppearanceStoredPackage, "assets"> | undefined): AppearanceAssetLease {
    const assets = new Map(packageValue?.assets.map((asset) => [asset.path, asset]) ?? []);
    const acquired = new Set<string>();
    const validated = new Map<string, Uint8Array | null>();
    let disposed = false;
    return {
      resolve: (path) => {
        if (disposed) return null;
        const asset = assets.get(path);
        if (asset === undefined) return null;
        let bytes = validated.get(path);
        if (bytes === undefined && !validated.has(path)) {
          const decoded = decodeBase64(asset.dataBase64);
          if (
            decoded === null ||
            decoded.byteLength !== asset.sizeBytes ||
            appearanceBytesSha256(decoded) !== asset.sha256 ||
            !matchesAppearanceAssetSignature(asset.mimeType, decoded)
          ) {
            validated.set(path, null);
            return null;
          }
          bytes = decoded;
          validated.set(path, bytes);
        }
        if (bytes === undefined || bytes === null) return null;
        const key = `${asset.mimeType}:${asset.sha256}`;
        const cached = this.#cache.get(key);
        if (cached !== undefined) {
          if (!acquired.has(key)) {
            cached.references += 1;
            acquired.add(key);
          }
          return cached.url;
        }
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        const url = this.#urls.create(new Blob([buffer], { type: asset.mimeType }));
        this.#cache.set(key, { url, references: 1 });
        acquired.add(key);
        return url;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        assets.clear();
        validated.clear();
        for (const key of acquired) {
          const cached = this.#cache.get(key);
          if (cached === undefined) continue;
          cached.references -= 1;
          if (cached.references > 0) continue;
          this.#cache.delete(key);
          this.#urls.revoke(cached.url);
        }
        acquired.clear();
      },
    };
  }
}
