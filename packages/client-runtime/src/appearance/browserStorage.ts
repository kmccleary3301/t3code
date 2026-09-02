// @effect-diagnostics globalDate:off globalRandom:off -- Browser storage uses host timestamps and a per-tab source identifier.
/* oxlint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin -- IndexedDB exposes mutable on* handlers and BroadcastChannel.postMessage has no target origin. */
import {
  appearanceBytesSha256,
  appearanceSha256,
  normalizeAppearance,
  matchesAppearanceAssetSignature,
} from "@t3tools/shared/appearance";
import { THEME_COLOR_ROLES } from "@t3tools/shared/themePalettes";
import { validateAppearancePackageCss, validateAppearanceSnippetCss } from "./css.ts";
import type {
  AppearancePersistedState,
  AppearanceStorageAdapter,
  AppearanceStoredAsset,
  AppearanceStoredPackage,
  AppearanceVariant,
} from "./model.ts";
import { decodeAppearancePersistedState } from "./model.ts";

export const APPEARANCE_DATABASE_NAME = "t3code-appearance";
export const APPEARANCE_DATABASE_VERSION = 2;
export const APPEARANCE_BOOT_STORAGE_KEY = "t3code:appearance:boot:v1";
export const APPEARANCE_BROADCAST_STORAGE_KEY = "t3code:appearance:changed:v1";

export const APPEARANCE_MANIFEST_MAX_BYTES = 256 * 1024;
export const APPEARANCE_CSS_MAX_BYTES = 1024 * 1024;
export const APPEARANCE_PACKAGE_MAX_BYTES = 20 * 1024 * 1024;
export const APPEARANCE_FILE_MAX_COUNT = 256;
export const APPEARANCE_PATH_MAX_DEPTH = 8;
export const APPEARANCE_BOOT_MAX_BYTES = 8 * 1024;
export const APPEARANCE_STATE_MAX_BYTES = 64 * 1024 * 1024;

const STATE_STORE = "state";
const PACKAGES_STORE = "packages";
const CSS_STORE = "css";
const ASSETS_STORE = "assets";
const DIAGNOSTICS_STORE = "diagnostics";
const QUARANTINE_STORE = "quarantine";
const BOOT_VERSION = 2 as const;
const COLOR_ROLE_SET = new Set<string>(THEME_COLOR_ROLES);

type BrowserIdbMode = "readonly" | "readwrite";

export interface BrowserIdbRecord {
  readonly key: string;
  readonly value: string;
}

export interface BrowserIdbRequest<T> {
  readonly result: T;
  readonly error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface BrowserIdbUpgradeEvent {
  readonly oldVersion: number;
}

export interface BrowserIdbOpenRequest extends BrowserIdbRequest<BrowserIdbDatabase> {
  onupgradeneeded: ((event: BrowserIdbUpgradeEvent) => void) | null;
}

export interface BrowserIdbObjectStore {
  readonly get: (key: string) => BrowserIdbRequest<BrowserIdbRecord | undefined>;
  readonly put: (record: BrowserIdbRecord) => BrowserIdbRequest<void>;
  readonly delete: (key: string) => BrowserIdbRequest<void>;
  readonly clear: () => BrowserIdbRequest<void>;
}

export interface BrowserIdbTransaction {
  readonly objectStore: (name: string) => BrowserIdbObjectStore;
  readonly abort: () => void;
  oncomplete: ((event: Event) => void) | null;
  onabort: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface BrowserIdbDatabase {
  readonly transaction: (
    stores: ReadonlyArray<string>,
    mode: BrowserIdbMode,
  ) => BrowserIdbTransaction;
  readonly createObjectStore: (name: string, options: Readonly<{ keyPath: "key" }>) => void;
  readonly close: () => void;
}

export interface BrowserIndexedDbFactory {
  readonly open: (name: string, version: number) => BrowserIdbOpenRequest;
}

export interface BrowserLocalStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

export interface BrowserStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

export interface BrowserStorageEventSource {
  readonly subscribe: (listener: (event: BrowserStorageEvent) => void) => () => void;
}

export interface BrowserBroadcastMessageEvent {
  readonly data: string;
}

export interface BrowserBroadcastChannel {
  readonly postMessage: (message: string) => void;
  readonly addEventListener: (
    type: "message",
    listener: (event: BrowserBroadcastMessageEvent) => void,
  ) => void;
  readonly removeEventListener: (
    type: "message",
    listener: (event: BrowserBroadcastMessageEvent) => void,
  ) => void;
  readonly close: () => void;
}

export interface BrowserAppearanceStorageOptions {
  readonly databaseName?: string;
  readonly indexedDBFactory?: BrowserIndexedDbFactory;
  readonly localStorageFactory?: () => BrowserLocalStorage | null;
  readonly broadcastChannelFactory?: (name: string) => BrowserBroadcastChannel;
  readonly storageEventSourceFactory?: () => BrowserStorageEventSource | null;
  readonly initialState?: AppearancePersistedState;
}

export interface AppearanceBootSnapshot {
  readonly version: typeof BOOT_VERSION;
  readonly revision: number;
  readonly themeId: string;
  readonly mode: "system" | AppearanceVariant;
  readonly systemAppearance?: AppearanceVariant;
  readonly safeMode: boolean;
  readonly colorVariables: Readonly<Record<string, string>>;
  readonly checksum: string;
}

export class BrowserAppearanceStorageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BrowserAppearanceStorageError";
  }
}

export class BrowserAppearanceStorageConflictError extends BrowserAppearanceStorageError {
  public constructor(expectedRevision: number, actualRevision: number) {
    super(`Appearance revision conflict: expected ${expectedRevision}, found ${actualRevision}.`);
    this.name = "BrowserAppearanceStorageConflictError";
  }
}

export class BrowserAppearanceStorageBoundsError extends BrowserAppearanceStorageError {
  public constructor(message: string) {
    super(message);
    this.name = "BrowserAppearanceStorageBoundsError";
  }
}

function makeAbortError(): Error {
  const error = new Error("Appearance storage operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw makeAbortError();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeIdbRecord(value: unknown): BrowserIdbRecord | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.value !== "string") {
    return undefined;
  }
  return { key: value.key, value: value.value };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function hashAppearanceProfileContent(profile: AppearanceStoredPackage["profile"]): string {
  const { migration: _migration, ...content } = profile;
  return appearanceSha256(content);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === ".." || segment.length === 0) &&
    pathDepth(path) <= APPEARANCE_PATH_MAX_DEPTH
  );
}

function isSafeColor(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) return false;
  if (/[{};]|url\s*\(|javascript\s*:/iu.test(normalized)) return false;
  return /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]{1,240}\)|[a-z][a-z0-9-]{0,63})$/iu.test(
    normalized,
  );
}

function sortedRecordEntries(
  record: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [string, string]> {
  return Object.entries(record).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function checksum(value: unknown): string {
  const encoded = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < encoded.length; index += 1) {
    hash ^= encoded.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function decodeBootSnapshot(value: string): AppearanceBootSnapshot | null {
  if (utf8Length(value) > APPEARANCE_BOOT_MAX_BYTES) return null;
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return null;
  const version = parsed.version;
  const revision = parsed.revision;
  const themeId = parsed.themeId;
  const mode = parsed.mode;
  const colorVariables = parsed.colorVariables;
  const systemAppearance = parsed.systemAppearance;
  const digest = parsed.checksum;
  if (
    version !== BOOT_VERSION ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof themeId !== "string" ||
    themeId.length === 0 ||
    themeId.length > 128 ||
    (mode !== "system" && mode !== "light" && mode !== "dark") ||
    (systemAppearance !== undefined &&
      (mode !== "system" || (systemAppearance !== "light" && systemAppearance !== "dark"))) ||
    typeof parsed.safeMode !== "boolean" ||
    !isRecord(colorVariables) ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{8}$/u.test(digest)
  ) {
    return null;
  }
  const normalizedSystemAppearance: AppearanceVariant | undefined =
    systemAppearance === "light" || systemAppearance === "dark" ? systemAppearance : undefined;
  const verified: Record<string, string> = {};
  const entries = Object.entries(colorVariables);
  if (entries.length > 128) return null;
  for (const [name, rawValue] of entries) {
    if (
      !/^--(?:t3|app-theme)-[a-z0-9-]{1,96}$/u.test(name) ||
      typeof rawValue !== "string" ||
      !isSafeColor(rawValue)
    ) {
      return null;
    }
    verified[name] = rawValue.trim();
  }
  const body = {
    version: BOOT_VERSION,
    revision,
    themeId,
    mode,
    ...(normalizedSystemAppearance === undefined
      ? {}
      : { systemAppearance: normalizedSystemAppearance }),
    safeMode: parsed.safeMode,
    colorVariables: Object.fromEntries(sortedRecordEntries(verified)),
  } as const;
  if (checksum(body) !== digest) return null;
  return { ...body, checksum: digest };
}

function nativeLocalStorage(): BrowserLocalStorage | null {
  let storage: Storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    return null;
  }
  if (storage === undefined) return null;
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

function nativeStorageEvents(): BrowserStorageEventSource | null {
  let window: Window;
  try {
    window = globalThis.window;
  } catch {
    return null;
  }
  if (window === undefined) return null;
  return {
    subscribe: (listener) => {
      const handler = (event: StorageEvent): void =>
        listener({ key: event.key, newValue: event.newValue });
      try {
        window.addEventListener("storage", handler);
      } catch {
        return () => undefined;
      }
      return () => window.removeEventListener("storage", handler);
    },
  };
}

function adaptNativeRequest<Input, Output>(
  request: IDBRequest<Input>,
  map: (value: Input) => Output,
): BrowserIdbRequest<Output> {
  const adapted: BrowserIdbRequest<Output> = {
    get result() {
      return map(request.result);
    },
    get error() {
      return request.error;
    },
    onsuccess: null,
    onerror: null,
  };
  request.onsuccess = (event) => adapted.onsuccess?.(event);
  request.onerror = (event) => adapted.onerror?.(event);
  return adapted;
}

function adaptNativeDatabase(database: IDBDatabase): BrowserIdbDatabase {
  return {
    transaction: (stores, mode) => adaptNativeTransaction(database.transaction([...stores], mode)),
    createObjectStore: (name, options) => {
      database.createObjectStore(name, options);
    },
    close: () => database.close(),
  };
}

function adaptNativeStore(store: IDBObjectStore): BrowserIdbObjectStore {
  return {
    get: (key) =>
      adaptNativeRequest(store.get(key), (value) => {
        const record = decodeIdbRecord(value);
        return record;
      }),
    put: (record) => adaptNativeRequest(store.put(record), (): void => undefined),
    delete: (key) => adaptNativeRequest(store.delete(key), (): void => undefined),
    clear: () => adaptNativeRequest(store.clear(), (): void => undefined),
  };
}

function adaptNativeTransaction(transaction: IDBTransaction): BrowserIdbTransaction {
  const adapted: BrowserIdbTransaction = {
    objectStore: (name) => adaptNativeStore(transaction.objectStore(name)),
    abort: () => transaction.abort(),
    oncomplete: null,
    onabort: null,
    onerror: null,
  };
  transaction.oncomplete = (event) => adapted.oncomplete?.(event);
  transaction.onabort = (event) => adapted.onabort?.(event);
  transaction.onerror = (event) => adapted.onerror?.(event);
  return adapted;
}

function nativeIndexedDb(): BrowserIndexedDbFactory | null {
  let indexedDB: IDBFactory;
  try {
    indexedDB = globalThis.indexedDB;
  } catch {
    return null;
  }
  if (indexedDB === undefined) return null;
  return {
    open: (name, version) => {
      const request = indexedDB.open(name, version);
      const adapted: BrowserIdbOpenRequest = {
        get result() {
          return adaptNativeDatabase(request.result);
        },
        get error() {
          return request.error;
        },
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      request.onupgradeneeded = (event) =>
        adapted.onupgradeneeded?.({ oldVersion: event.oldVersion });
      request.onsuccess = (event) => adapted.onsuccess?.(event);
      request.onerror = (event) => adapted.onerror?.(event);
      return adapted;
    },
  };
}

function nativeBroadcastChannel(name: string): BrowserBroadcastChannel | null {
  let Channel: typeof BroadcastChannel;
  let channel: BroadcastChannel;
  try {
    Channel = globalThis.BroadcastChannel;
    if (Channel === undefined) return null;
    channel = new Channel(name);
  } catch {
    return null;
  }
  const listeners = new Map<
    (event: BrowserBroadcastMessageEvent) => void,
    (event: MessageEvent) => void
  >();
  return {
    postMessage: (message) => channel.postMessage(message),
    addEventListener: (_type, listener) => {
      const handler = (event: MessageEvent): void => {
        if (typeof event.data === "string") listener({ data: event.data });
      };
      listeners.set(listener, handler);
      channel.addEventListener("message", handler);
    },
    removeEventListener: (_type, listener) => {
      const handler = listeners.get(listener);
      if (handler !== undefined) {
        channel.removeEventListener("message", handler);
        listeners.delete(listener);
      }
    },
    close: () => channel.close(),
  };
}

function record(key: string, value: string): BrowserIdbRecord {
  return { key, value };
}

function packageJson(packageValue: AppearanceStoredPackage): string {
  return JSON.stringify(packageValue);
}

function bytesFor(value: string): number {
  return utf8Length(value);
}

function addPackageBounds(id: string, packageValue: AppearanceStoredPackage): void {
  const manifest = JSON.stringify(packageValue.manifest);
  if (manifest === undefined || bytesFor(manifest) > APPEARANCE_MANIFEST_MAX_BYTES) {
    throw new BrowserAppearanceStorageBoundsError(`Manifest for ${id} exceeds 256 KiB.`);
  }
  if (appearanceSha256(packageValue.manifest) !== packageValue.manifestHash) {
    throw new BrowserAppearanceStorageBoundsError(`Manifest checksum for ${id} is invalid.`);
  }
  const normalized = normalizeAppearance(packageValue.manifest, {
    trust: packageValue.profile.trust,
    platform: "web",
  });
  if (
    normalized.status === "failure" ||
    hashAppearanceProfileContent(normalized.profile) !==
      hashAppearanceProfileContent(packageValue.profile)
  ) {
    throw new BrowserAppearanceStorageBoundsError(
      `Manifest and normalized profile for ${id} do not match.`,
    );
  }
  const styleInputs = [
    ["shared CSS", packageValue.sharedCss, packageValue.manifest.styles?.web],
    ["desktop CSS", packageValue.desktopCss, packageValue.manifest.styles?.desktop],
  ] as const;
  for (const [name, css, declaration] of styleInputs) {
    if ((css === undefined) !== (declaration === undefined)) {
      throw new BrowserAppearanceStorageBoundsError(`${name} declaration for ${id} is incomplete.`);
    }
    if (css !== undefined && declaration !== undefined) {
      const encoded = new TextEncoder().encode(css);
      if (
        encoded.byteLength !== declaration.sizeBytes ||
        appearanceBytesSha256(encoded) !== declaration.sha256
      ) {
        throw new BrowserAppearanceStorageBoundsError(`${name} checksum for ${id} is invalid.`);
      }
    }
  }
  const assetDeclarations = new Map(packageValue.manifest.assets.map((asset) => [asset.id, asset]));
  const assetPaths = new Set<string>();
  for (const asset of packageValue.assets) {
    const foldedPath = asset.path.toLowerCase();
    if (assetPaths.has(foldedPath)) {
      throw new BrowserAppearanceStorageBoundsError(
        `Asset path ${asset.path} for ${id} is duplicated.`,
      );
    }
    assetPaths.add(foldedPath);
  }
  if (assetDeclarations.size !== packageValue.assets.length) {
    throw new BrowserAppearanceStorageBoundsError(
      `Asset declarations for ${id} do not match stored assets.`,
    );
  }
  for (const asset of packageValue.assets) {
    const declaration = assetDeclarations.get(asset.id);
    if (
      declaration === undefined ||
      declaration.path !== asset.path ||
      declaration.sha256 !== asset.sha256 ||
      declaration.sizeBytes !== asset.sizeBytes ||
      declaration.mimeType !== asset.mimeType
    ) {
      throw new BrowserAppearanceStorageBoundsError(
        `Asset declaration for ${asset.id} does not match stored bytes.`,
      );
    }
  }
  const declaredAssetPaths = new Set(packageValue.assets.map((asset) => asset.path));
  let bytes = bytesFor(manifest);
  let files = 1;
  for (const [name, css] of [
    ["shared CSS", packageValue.sharedCss],
    ["desktop CSS", packageValue.desktopCss],
  ] as const) {
    if (css === undefined) continue;
    validateAppearancePackageCss(css, declaredAssetPaths, `${id}/${name}`);
    const size = bytesFor(css);
    if (size > APPEARANCE_CSS_MAX_BYTES) {
      throw new BrowserAppearanceStorageBoundsError(`${name} for ${id} exceeds 1 MiB.`);
    }
    bytes += size;
    files += 1;
  }
  for (const asset of packageValue.assets) {
    validateAsset(asset);
    bytes += asset.sizeBytes;
    files += 1;
  }
  if (files > APPEARANCE_FILE_MAX_COUNT) {
    throw new BrowserAppearanceStorageBoundsError(`Package ${id} contains too many files.`);
  }
  if (bytes > APPEARANCE_PACKAGE_MAX_BYTES) {
    throw new BrowserAppearanceStorageBoundsError(`Package ${id} exceeds 20 MiB.`);
  }
  if (packageValue.diagnostics.length > 128) {
    throw new BrowserAppearanceStorageBoundsError(`Package ${id} contains too many diagnostics.`);
  }
}

function validateAsset(asset: AppearanceStoredAsset): void {
  if (
    !isSafePath(asset.path) ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes < 1 ||
    asset.sizeBytes > APPEARANCE_PACKAGE_MAX_BYTES ||
    !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(asset.dataBase64)
  ) {
    throw new BrowserAppearanceStorageBoundsError(`Asset ${asset.id} is invalid.`);
  }
  let bytes: Uint8Array;
  try {
    const decoded = globalThis.atob(asset.dataBase64);
    bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new BrowserAppearanceStorageBoundsError(`Asset ${asset.id} is not valid base64.`);
  }
  if (
    bytes.byteLength !== asset.sizeBytes ||
    appearanceBytesSha256(bytes) !== asset.sha256 ||
    !matchesAppearanceAssetSignature(asset.mimeType, bytes)
  ) {
    throw new BrowserAppearanceStorageBoundsError(
      `Asset ${asset.id} checksum, size, or MIME signature is invalid.`,
    );
  }
}

function validateState(state: AppearancePersistedState): string {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new BrowserAppearanceStorageBoundsError("Appearance revision is invalid.");
  }
  const decoded = decodeAppearancePersistedState(state);
  if (decoded === null)
    throw new BrowserAppearanceStorageError("Appearance state failed schema validation.");
  const packageIds = Object.keys(state.packages);
  if (packageIds.length > APPEARANCE_FILE_MAX_COUNT) {
    throw new BrowserAppearanceStorageBoundsError(
      "Appearance package count exceeds the configured limit.",
    );
  }
  if (state.order.length !== packageIds.length) {
    throw new BrowserAppearanceStorageBoundsError(
      "Appearance order must contain every installed package exactly once.",
    );
  }
  const seenOrder = new Set<string>();
  for (const id of state.order) {
    if (!Object.hasOwn(state.packages, id) || seenOrder.has(id)) {
      throw new BrowserAppearanceStorageBoundsError(
        "Appearance order contains an unknown or duplicate package.",
      );
    }
    seenOrder.add(id);
  }
  for (const [id, packageValue] of Object.entries(state.packages)) {
    addPackageBounds(id, packageValue);
  }
  if (state.environmentPackages.length > APPEARANCE_FILE_MAX_COUNT) {
    throw new BrowserAppearanceStorageBoundsError(
      "Environment appearance package count exceeds the configured limit.",
    );
  }
  for (const [index, packageValue] of state.environmentPackages.entries()) {
    addPackageBounds(`environment-${index}`, packageValue);
  }
  if (state.snippets.length > APPEARANCE_FILE_MAX_COUNT) {
    throw new BrowserAppearanceStorageBoundsError(
      "Appearance snippet count exceeds the configured limit.",
    );
  }
  for (const snippet of state.snippets) {
    if (bytesFor(snippet.css) > APPEARANCE_CSS_MAX_BYTES) {
      throw new BrowserAppearanceStorageBoundsError(`Snippet ${snippet.id} exceeds 1 MiB.`);
    }
    validateAppearanceSnippetCss(snippet.css);
  }
  if (state.diagnostics.length > 256) {
    throw new BrowserAppearanceStorageBoundsError("Appearance diagnostic count exceeds its bound.");
  }
  const encoded = JSON.stringify(state);
  if (encoded === undefined) {
    throw new BrowserAppearanceStorageError("Appearance state is not serializable.");
  }
  if (bytesFor(encodeStoredState(state)) > APPEARANCE_STATE_MAX_BYTES) {
    throw new BrowserAppearanceStorageBoundsError("Appearance state exceeds 64 MiB.");
  }
  return encoded;
}

function bootVariantFor(
  packageValue: AppearanceStoredPackage | undefined,
  state: AppearancePersistedState,
  systemAppearance: AppearanceVariant | undefined,
) {
  const requestedAppearance =
    state.preference.mode === "system" ? systemAppearance : state.preference.mode;
  if (requestedAppearance === undefined || packageValue === undefined) return undefined;
  const exactVariant =
    state.preference.variantId === undefined
      ? undefined
      : packageValue.profile.variants.find(
          (candidate) => candidate.id === state.preference.variantId,
        );
  if (exactVariant !== undefined) return exactVariant;
  const modeVariant = packageValue.profile.variants.find(
    (candidate) => candidate.appearance === requestedAppearance,
  );
  if (modeVariant !== undefined) return modeVariant;
  if (packageValue.profile.fallback[requestedAppearance] === "reject") return undefined;
  return packageValue.profile.variants.find(
    (candidate) => candidate.id === packageValue.profile.defaultVariant,
  );
}

function selectBootPackage(
  state: AppearancePersistedState,
  systemAppearance: AppearanceVariant | undefined,
): AppearanceStoredPackage | undefined {
  const halfId =
    systemAppearance === "light"
      ? state.preference.lightPackageId
      : systemAppearance === "dark"
        ? state.preference.darkPackageId
        : undefined;
  const preferredId = halfId ?? state.preference.packageId;
  const canBoot = (packageValue: AppearanceStoredPackage): boolean =>
    packageValue.enabled && bootVariantFor(packageValue, state, systemAppearance) !== undefined;
  const preferred = preferredId === undefined ? undefined : state.packages[preferredId];
  if (preferred !== undefined && canBoot(preferred)) return preferred;
  for (const id of state.order) {
    const packageValue = state.packages[id];
    if (packageValue !== undefined && canBoot(packageValue)) return packageValue;
  }
  return Object.values(state.packages).find(canBoot);
}

function bootColorVariable(role: string): string {
  const suffix =
    role === "terminalSelection"
      ? "terminal-selection-background"
      : role.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
  return `--app-theme-${suffix}`;
}

function makeBootSnapshot(state: AppearancePersistedState): AppearanceBootSnapshot {
  const systemAppearance: AppearanceVariant | undefined =
    state.preference.mode === "system" &&
    (state.preference.variantId === "light" || state.preference.variantId === "dark")
      ? state.preference.variantId
      : undefined;
  const selected = state.safeMode ? undefined : selectBootPackage(state, systemAppearance);
  const packageValue =
    selected?.profile.compatibility.minimumAppVersion !== undefined ||
    selected?.profile.compatibility.maximumAppVersion !== undefined
      ? undefined
      : selected;
  const requestedAppearance =
    state.preference.mode === "system" ? systemAppearance : state.preference.mode;
  const variant =
    requestedAppearance === undefined
      ? undefined
      : bootVariantFor(packageValue, state, systemAppearance);
  const variables: Record<string, string> = {};
  const themeId =
    variant === undefined ? "builtin" : (packageValue?.manifest.metadata.id ?? "builtin");
  if (variant !== undefined) {
    for (const [role, value] of Object.entries(variant.colors)) {
      if (typeof value === "string" && isSafeColor(value)) {
        variables[bootColorVariable(role)] = value.trim();
      }
    }
  }
  const addLayer = (layer: Readonly<Record<string, string>> | undefined): void => {
    if (layer === undefined) return;
    for (const [name, value] of Object.entries(layer)) {
      const variable = COLOR_ROLE_SET.has(name)
        ? bootColorVariable(name)
        : /^--[a-z][a-z0-9-]{0,126}$/u.test(name)
          ? name
          : /^[a-z][A-Za-z0-9]{0,63}$/u.test(name)
            ? `--t3-${name.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)}`
            : null;
      if (variable !== null && isSafeColor(value)) variables[variable] = value.trim();
    }
  };
  addLayer(state.preference.overrides);
  addLayer(state.accessibility);
  const body = {
    version: BOOT_VERSION,
    revision: state.revision,
    themeId,
    mode:
      state.safeMode || state.preference.mode === "system"
        ? "system"
        : (variant?.appearance ?? state.preference.mode),
    ...(state.preference.mode === "system" &&
    !state.safeMode &&
    variant !== undefined &&
    systemAppearance !== undefined
      ? { systemAppearance }
      : {}),
    safeMode: state.safeMode,
    colorVariables: Object.fromEntries(sortedRecordEntries(variables)),
  } as const;
  return { ...body, checksum: checksum(body) };
}
export function readAppearanceBootSnapshot(
  storage?: BrowserLocalStorage | null,
): AppearanceBootSnapshot | null {
  const target = storage ?? nativeLocalStorage();
  if (target === null) return null;
  try {
    const value = target.getItem(APPEARANCE_BOOT_STORAGE_KEY);
    return value === null ? null : decodeBootSnapshot(value);
  } catch {
    return null;
  }
}

function installStores(database: BrowserIdbDatabase, oldVersion: number): void {
  const names =
    oldVersion === 0
      ? [STATE_STORE, PACKAGES_STORE, CSS_STORE, ASSETS_STORE, DIAGNOSTICS_STORE, QUARANTINE_STORE]
      : [QUARANTINE_STORE];
  for (const name of names) database.createObjectStore(name, { keyPath: "key" });
}

function encodeStoredState(state: AppearancePersistedState): string {
  return JSON.stringify({
    version: 1,
    state,
    checksum: appearanceSha256(state),
  });
}

interface DecodedStoredState {
  readonly state: AppearancePersistedState;
  readonly legacy: boolean;
}

function decodeStoredState(value: string): DecodedStoredState | null {
  if (utf8Length(value) > APPEARANCE_STATE_MAX_BYTES) return null;
  const parsed = parseJson(value);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    "state" in parsed &&
    "checksum" in parsed
  ) {
    if (parsed.version !== 1 || typeof parsed.checksum !== "string") return null;
    const decoded = decodeAppearancePersistedState(parsed.state);
    return decoded !== null && appearanceSha256(decoded) === parsed.checksum
      ? { state: decoded, legacy: false }
      : null;
  }
  const decoded = decodeAppearancePersistedState(parsed);
  return decoded === null ? null : { state: decoded, legacy: true };
}
function decodeStoredRevision(value: string): number | null {
  if (utf8Length(value) > APPEARANCE_STATE_MAX_BYTES) return null;
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate =
    "version" in parsed && "state" in parsed && typeof parsed.state === "object"
      ? parsed.state
      : parsed;
  if (candidate === null || !("revision" in candidate)) return null;
  return typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0
    ? candidate.revision
    : null;
}

function rejectTransaction(transaction: BrowserIdbTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be complete; its original error remains authoritative.
  }
}

export class BrowserAppearanceStorage implements AppearanceStorageAdapter {
  private readonly databaseName: string;
  private readonly indexedDBFactory: BrowserIndexedDbFactory | null;
  private readonly localStorage: BrowserLocalStorage | null;
  private readonly broadcastChannel: BrowserBroadcastChannel | null;
  private readonly storageEvents: BrowserStorageEventSource | null;
  private readonly initialState: AppearancePersistedState | undefined;
  private readonly listeners = new Set<(state: AppearancePersistedState) => void>();
  private readonly sourceId = `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  private readonly channelListener: ((event: BrowserBroadcastMessageEvent) => void) | null;
  private readonly unsubscribeStorageEvents: (() => void) | null;
  private databasePromise: Promise<BrowserIdbDatabase> | null = null;
  private state: AppearancePersistedState | undefined;
  private latestRevision = -1;
  private emittedRevision = -1;
  private reconcileInFlight: Promise<void> | null = null;
  private pendingRemoteRevision = -1;

  public constructor(options: BrowserAppearanceStorageOptions = {}) {
    this.databaseName = options.databaseName ?? APPEARANCE_DATABASE_NAME;
    this.indexedDBFactory = options.indexedDBFactory ?? nativeIndexedDb();
    this.localStorage = options.localStorageFactory?.() ?? nativeLocalStorage();
    this.initialState = options.initialState;
    this.broadcastChannel =
      options.broadcastChannelFactory?.(APPEARANCE_BROADCAST_STORAGE_KEY) ??
      nativeBroadcastChannel(APPEARANCE_BROADCAST_STORAGE_KEY);
    this.storageEvents = options.storageEventSourceFactory?.() ?? nativeStorageEvents();
    this.channelListener =
      this.broadcastChannel === null ? null : (event) => this.handleMessage(event.data);
    if (this.broadcastChannel !== null && this.channelListener !== null) {
      this.broadcastChannel.addEventListener("message", this.channelListener);
    }
    this.unsubscribeStorageEvents =
      this.storageEvents?.subscribe((event) => {
        if (event.key === APPEARANCE_BROADCAST_STORAGE_KEY && event.newValue !== null)
          this.handleMessage(event.newValue);
      }) ?? null;
  }

  public static readBootSnapshot(
    storage?: BrowserLocalStorage | null,
  ): AppearanceBootSnapshot | null {
    return readAppearanceBootSnapshot(storage);
  }

  public async load(signal?: AbortSignal): Promise<AppearancePersistedState> {
    throwIfAborted(signal);
    const database = await this.openDatabase();
    const transaction = database.transaction([STATE_STORE], "readonly");
    const store = transaction.objectStore(STATE_STORE);
    let loaded: AppearancePersistedState | undefined;
    let failure: Error | undefined;
    let legacyLoaded = false;
    const loadedResult = await new Promise<AppearancePersistedState>((resolve, reject) => {
      transaction.oncomplete = () => {
        if (failure !== undefined) {
          reject(failure);
        } else if (loaded !== undefined) {
          resolve(loaded);
        } else if (this.initialState !== undefined) {
          resolve(this.initialState);
        } else {
          reject(new BrowserAppearanceStorageError("Appearance state is not initialized."));
        }
      };
      transaction.onabort = () =>
        reject(failure ?? new BrowserAppearanceStorageError("IndexedDB transaction aborted."));
      transaction.onerror = () =>
        reject(failure ?? new BrowserAppearanceStorageError("IndexedDB transaction failed."));
      const request = store.get("current");
      request.onsuccess = () => {
        const value = request.result;
        if (value === undefined) return;
        const decoded = decodeStoredState(value.value);
        if (decoded === null) {
          failure = new BrowserAppearanceStorageError(
            "Stored appearance state failed schema validation.",
          );
          rejectTransaction(transaction);
          return;
        }
        try {
          validateState(decoded.state);
        } catch (error) {
          failure =
            error instanceof Error
              ? error
              : new BrowserAppearanceStorageError("Stored appearance state is invalid.");
          rejectTransaction(transaction);
          return;
        }
        loaded = decoded.state;
        legacyLoaded = decoded.legacy;
      };
      request.onerror = () => {
        failure =
          request.error ?? new BrowserAppearanceStorageError("IndexedDB state read failed.");
        rejectTransaction(transaction);
      };
    });
    const result = legacyLoaded
      ? await this.upgradeStateDocument(database, loadedResult, signal)
      : loadedResult;
    this.state = result;
    this.latestRevision = Math.max(this.latestRevision, result.revision);
    return result;
  }

  public async commit(
    expectedRevision: number,
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    validateState(state);
    const encodedState = encodeStoredState(state);
    const localStorage = this.localStorage;
    let previousBoot: string | null = null;
    if (localStorage !== null) {
      try {
        previousBoot = localStorage.getItem(APPEARANCE_BOOT_STORAGE_KEY);
      } catch (error) {
        throw new BrowserAppearanceStorageError(
          `Unable to read appearance boot snapshot: ${String(error)}`,
        );
      }
    }
    const database = await this.openDatabase();
    const previousState = await this.writeStateTransaction(
      database,
      expectedRevision,
      state,
      encodedState,
      signal,
    );
    try {
      if (localStorage !== null) {
        const snapshot = makeBootSnapshot(state);
        const encodedBoot = JSON.stringify(snapshot);
        if (utf8Length(encodedBoot) > APPEARANCE_BOOT_MAX_BYTES) {
          throw new BrowserAppearanceStorageBoundsError("Appearance boot snapshot exceeds 8 KiB.");
        }
        localStorage.setItem(APPEARANCE_BOOT_STORAGE_KEY, encodedBoot);
        const current = await this.readCurrentState(database);
        if (current !== undefined && current.revision > state.revision) {
          const currentBoot = JSON.stringify(makeBootSnapshot(current));
          if (utf8Length(currentBoot) > APPEARANCE_BOOT_MAX_BYTES) {
            throw new BrowserAppearanceStorageBoundsError(
              "Appearance boot snapshot exceeds 8 KiB.",
            );
          }
          localStorage.setItem(APPEARANCE_BOOT_STORAGE_KEY, currentBoot);
          this.state = current;
          this.latestRevision = current.revision;
          this.notify(current);
          throw new BrowserAppearanceStorageConflictError(state.revision, current.revision);
        }
      }
    } catch (error) {
      try {
        await this.restoreState(database, previousState, state.revision);
        if (localStorage !== null) {
          const currentBoot = readAppearanceBootSnapshot(localStorage);
          if (currentBoot === null || currentBoot.revision <= state.revision) {
            if (previousBoot === null) localStorage.removeItem(APPEARANCE_BOOT_STORAGE_KEY);
            else localStorage.setItem(APPEARANCE_BOOT_STORAGE_KEY, previousBoot);
          }
        }
      } catch (rollbackError) {
        throw new BrowserAppearanceStorageError(
          `Appearance commit failed and rollback failed: ${String(rollbackError)}`,
        );
      }
      throw error;
    }
    this.state = state;
    this.latestRevision = state.revision;
    this.notify(state);
    this.publish(state);
  }

  public async recover(
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ): Promise<AppearancePersistedState> {
    throwIfAborted(signal);
    validateState(state);
    const database = await this.openDatabase();
    const bootRevision =
      this.localStorage === null
        ? -1
        : (readAppearanceBootSnapshot(this.localStorage)?.revision ?? -1);
    const transaction = database.transaction(
      [STATE_STORE, PACKAGES_STORE, CSS_STORE, ASSETS_STORE, DIAGNOSTICS_STORE, QUARANTINE_STORE],
      "readwrite",
    );
    let recovered = state;
    let failure: Error | undefined;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        failure = makeAbortError();
        rejectTransaction(transaction);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (callback: () => void): void => {
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      transaction.oncomplete = () =>
        finish(() => (failure === undefined ? resolve() : reject(failure)));
      transaction.onabort = () =>
        finish(() =>
          reject(failure ?? new BrowserAppearanceStorageError("IndexedDB recovery aborted.")),
        );
      transaction.onerror = () =>
        finish(() =>
          reject(failure ?? new BrowserAppearanceStorageError("IndexedDB recovery failed.")),
        );
      const stateStore = transaction.objectStore(STATE_STORE);
      const request = stateStore.get("current");
      request.onsuccess = () => {
        try {
          const durableRevision =
            request.result === undefined ? null : decodeStoredRevision(request.result.value);
          recovered = {
            ...state,
            revision:
              Math.max(
                state.revision - 1,
                durableRevision ?? -1,
                this.latestRevision,
                bootRevision,
              ) + 1,
          };
          validateState(recovered);
          const priorRecord = request.result;
          if (
            priorRecord !== undefined &&
            utf8Length(priorRecord.value) <= APPEARANCE_STATE_MAX_BYTES
          ) {
            transaction.objectStore(QUARANTINE_STORE).put(record("latest", priorRecord.value));
          } else if (this.state !== undefined) {
            transaction
              .objectStore(QUARANTINE_STORE)
              .put(record("latest", encodeStoredState(this.state)));
          }
          stateStore.clear();
          transaction.objectStore(PACKAGES_STORE).clear();
          transaction.objectStore(CSS_STORE).clear();
          transaction.objectStore(ASSETS_STORE).clear();
          transaction.objectStore(DIAGNOSTICS_STORE).clear();
          stateStore.put(record("current", encodeStoredState(recovered)));
          this.writePackageRecords(transaction, recovered);
          transaction
            .objectStore(DIAGNOSTICS_STORE)
            .put(record("state", JSON.stringify(recovered.diagnostics)));
        } catch (error) {
          failure =
            error instanceof Error ? error : new BrowserAppearanceStorageError(String(error));
          rejectTransaction(transaction);
        }
      };
      request.onerror = () => {
        failure =
          request.error ?? new BrowserAppearanceStorageError("IndexedDB recovery read failed.");
        rejectTransaction(transaction);
      };
    });
    if (this.localStorage !== null) {
      try {
        const boot = JSON.stringify(makeBootSnapshot(recovered));
        if (utf8Length(boot) <= APPEARANCE_BOOT_MAX_BYTES) {
          this.localStorage.setItem(APPEARANCE_BOOT_STORAGE_KEY, boot);
        } else {
          this.localStorage.removeItem(APPEARANCE_BOOT_STORAGE_KEY);
        }
      } catch {
        try {
          this.localStorage.removeItem(APPEARANCE_BOOT_STORAGE_KEY);
        } catch {
          // Durable recovery remains authoritative when the synchronous cache is unavailable.
        }
      }
    }
    this.state = recovered;
    this.latestRevision = recovered.revision;
    this.notify(recovered);
    this.publish(recovered);
    return recovered;
  }

  public async readQuarantinedState(): Promise<AppearancePersistedState | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction([QUARANTINE_STORE], "readonly");
    const request = transaction.objectStore(QUARANTINE_STORE).get("latest");
    return new Promise<AppearancePersistedState | null>((resolve, reject) => {
      let value: AppearancePersistedState | null = null;
      let failure: Error | undefined;
      transaction.oncomplete = () => (failure === undefined ? resolve(value) : reject(failure));
      transaction.onabort = () =>
        reject(failure ?? new BrowserAppearanceStorageError("Quarantine read aborted."));
      transaction.onerror = () =>
        reject(failure ?? new BrowserAppearanceStorageError("Quarantine read failed."));
      request.onsuccess = () => {
        value =
          request.result === undefined
            ? null
            : (decodeStoredState(request.result.value)?.state ?? null);
      };
      request.onerror = () => {
        failure =
          request.error ?? new BrowserAppearanceStorageError("Quarantine record read failed.");
        rejectTransaction(transaction);
      };
    });
  }

  public async restoreQuarantinedState(signal?: AbortSignal): Promise<AppearancePersistedState> {
    const quarantined = await this.readQuarantinedState();
    if (quarantined === null) {
      throw new BrowserAppearanceStorageError("No valid quarantined appearance state exists.");
    }
    const expectedQuarantineHash = appearanceSha256(quarantined);
    const current = await this.load(signal);
    const restored = {
      ...quarantined,
      revision: current.revision + 1,
      safeMode: false,
      environmentPackages: [],
    };
    validateState(restored);
    await this.commit(current.revision, restored, signal);
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([QUARANTINE_STORE], "readwrite");
      let failure: Error | undefined;
      transaction.oncomplete = () => (failure === undefined ? resolve() : reject(failure));
      transaction.onabort = () =>
        reject(failure ?? new BrowserAppearanceStorageError("Quarantine cleanup aborted."));
      transaction.onerror = () =>
        reject(failure ?? new BrowserAppearanceStorageError("Quarantine cleanup failed."));
      const store = transaction.objectStore(QUARANTINE_STORE);
      const request = store.get("latest");
      request.onsuccess = () => {
        const latest = request.result;
        const decoded =
          latest === undefined ? null : (decodeStoredState(latest.value)?.state ?? null);
        if (decoded === null || appearanceSha256(decoded) !== expectedQuarantineHash) return;
        const deletion = store.delete("latest");
        deletion.onerror = () => {
          failure =
            deletion.error ??
            new BrowserAppearanceStorageError("Quarantine cleanup request failed.");
          rejectTransaction(transaction);
        };
      };
      request.onerror = () => {
        failure =
          request.error ?? new BrowserAppearanceStorageError("Quarantine cleanup read failed.");
        rejectTransaction(transaction);
      };
    });
    return restored;
  }

  public subscribe(listener: (state: AppearancePersistedState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    if (this.broadcastChannel !== null && this.channelListener !== null) {
      this.broadcastChannel.removeEventListener("message", this.channelListener);
      this.broadcastChannel.close();
    }
    this.unsubscribeStorageEvents?.();
    if (this.databasePromise !== null) {
      void this.databasePromise.then((database) => database.close()).catch(() => undefined);
    }
  }

  private async openDatabase(): Promise<BrowserIdbDatabase> {
    if (this.databasePromise !== null) return this.databasePromise;
    const factory = this.indexedDBFactory;
    if (factory === null) throw new BrowserAppearanceStorageError("IndexedDB is unavailable.");
    this.databasePromise = new Promise<BrowserIdbDatabase>((resolve, reject) => {
      let request: BrowserIdbOpenRequest;
      try {
        request = factory.open(this.databaseName, APPEARANCE_DATABASE_VERSION);
      } catch (error) {
        reject(new BrowserAppearanceStorageError(`Unable to open IndexedDB: ${String(error)}`));
        return;
      }
      request.onupgradeneeded = (event) => {
        try {
          installStores(request.result, event.oldVersion);
        } catch (error) {
          reject(
            new BrowserAppearanceStorageError(
              `Unable to create appearance stores: ${String(error)}`,
            ),
          );
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new BrowserAppearanceStorageError("Unable to open IndexedDB."));
    });
    try {
      return await this.databasePromise;
    } catch (error) {
      this.databasePromise = null;
      throw error;
    }
  }
  private readCurrentState(
    database: BrowserIdbDatabase,
  ): Promise<AppearancePersistedState | undefined> {
    const transaction = database.transaction([STATE_STORE], "readonly");
    const request = transaction.objectStore(STATE_STORE).get("current");
    let state: AppearancePersistedState | undefined;
    let failure: Error | undefined;
    return new Promise<AppearancePersistedState | undefined>((resolve, reject) => {
      transaction.oncomplete = () => (failure === undefined ? resolve(state) : reject(failure));
      transaction.onabort = () =>
        reject(failure ?? new BrowserAppearanceStorageError("IndexedDB state read aborted."));
      transaction.onerror = () =>
        reject(failure ?? new BrowserAppearanceStorageError("IndexedDB state read failed."));
      request.onsuccess = () => {
        const stored = request.result;
        if (stored === undefined) return;
        const decoded = decodeStoredState(stored.value);
        if (decoded === null) {
          failure = new BrowserAppearanceStorageError(
            "Stored appearance state failed schema validation.",
          );
          rejectTransaction(transaction);
          return;
        }
        try {
          validateState(decoded.state);
          state = decoded.state;
        } catch (error) {
          failure =
            error instanceof Error
              ? error
              : new BrowserAppearanceStorageError("Stored appearance state is invalid.");
          rejectTransaction(transaction);
        }
      };
      request.onerror = () => {
        failure =
          request.error ?? new BrowserAppearanceStorageError("IndexedDB state read failed.");
        rejectTransaction(transaction);
      };
    });
  }

  private upgradeStateDocument(
    database: BrowserIdbDatabase,
    state: AppearancePersistedState,
    signal?: AbortSignal,
  ): Promise<AppearancePersistedState> {
    throwIfAborted(signal);
    const transaction = database.transaction([STATE_STORE], "readwrite");
    const store = transaction.objectStore(STATE_STORE);
    let authoritative = state;
    let failure: Error | undefined;
    return new Promise<AppearancePersistedState>((resolve, reject) => {
      const abort = (): void => {
        failure = makeAbortError();
        rejectTransaction(transaction);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (callback: () => void): void => {
        signal?.removeEventListener("abort", abort);
        callback();
      };
      transaction.oncomplete = () =>
        finish(() => (failure === undefined ? resolve(authoritative) : reject(failure)));
      transaction.onabort = () =>
        finish(() =>
          reject(failure ?? new BrowserAppearanceStorageError("State upgrade aborted.")),
        );
      transaction.onerror = () =>
        finish(() => reject(failure ?? new BrowserAppearanceStorageError("State upgrade failed.")));
      const request = store.get("current");
      request.onsuccess = () => {
        const current = request.result;
        if (current === undefined) return;
        const decoded = decodeStoredState(current.value);
        if (decoded === null) {
          failure = new BrowserAppearanceStorageError("Stored appearance state is invalid.");
          rejectTransaction(transaction);
          return;
        }
        authoritative = decoded.state;
        if (
          decoded.legacy &&
          decoded.state.revision === state.revision &&
          appearanceSha256(decoded.state) === appearanceSha256(state)
        ) {
          store.put(record("current", encodeStoredState(state)));
        }
      };
      request.onerror = () => {
        failure = request.error ?? new BrowserAppearanceStorageError("State upgrade read failed.");
        rejectTransaction(transaction);
      };
    });
  }

  private async writeStateTransaction(
    database: BrowserIdbDatabase,
    expectedRevision: number,
    state: AppearancePersistedState,
    encodedState: string,
    signal?: AbortSignal,
  ): Promise<AppearancePersistedState | undefined> {
    const transaction = database.transaction(
      [STATE_STORE, PACKAGES_STORE, CSS_STORE, ASSETS_STORE, DIAGNOSTICS_STORE],
      "readwrite",
    );
    let previous: AppearancePersistedState | undefined;
    let failure: Error | undefined;
    return new Promise<AppearancePersistedState | undefined>((resolve, reject) => {
      const onAbort = (): void => {
        failure = makeAbortError();
        rejectTransaction(transaction);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (callback: () => void): void => {
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      transaction.oncomplete = () =>
        finish(() => {
          if (failure !== undefined) reject(failure);
          else resolve(previous);
        });
      transaction.onabort = () =>
        finish(() =>
          reject(failure ?? new BrowserAppearanceStorageError("IndexedDB transaction aborted.")),
        );
      transaction.onerror = () =>
        finish(() =>
          reject(failure ?? new BrowserAppearanceStorageError("IndexedDB transaction failed.")),
        );
      const stateStore = transaction.objectStore(STATE_STORE);
      const stateRequest = stateStore.get("current");
      stateRequest.onsuccess = () => {
        const existing = stateRequest.result;
        if (existing !== undefined) {
          previous = decodeStoredState(existing.value)?.state;
          if (previous === undefined) {
            failure = new BrowserAppearanceStorageError(
              "Stored appearance state failed schema validation.",
            );
            rejectTransaction(transaction);
            return;
          }
        }
        const actualRevision = previous?.revision ?? this.initialState?.revision ?? 0;
        if (actualRevision !== expectedRevision) {
          failure = new BrowserAppearanceStorageConflictError(expectedRevision, actualRevision);
          rejectTransaction(transaction);
          return;
        }
        if (state.revision <= expectedRevision) {
          failure = new BrowserAppearanceStorageConflictError(expectedRevision, state.revision);
          rejectTransaction(transaction);
          return;
        }
        try {
          transaction.objectStore(PACKAGES_STORE).clear();
          transaction.objectStore(CSS_STORE).clear();
          transaction.objectStore(ASSETS_STORE).clear();
          transaction.objectStore(DIAGNOSTICS_STORE).clear();
          stateStore.put(record("current", encodedState));
          this.writePackageRecords(transaction, state);
          transaction
            .objectStore(DIAGNOSTICS_STORE)
            .put(record("state", JSON.stringify(state.diagnostics)));
        } catch (error) {
          failure =
            error instanceof Error ? error : new BrowserAppearanceStorageError(String(error));
          rejectTransaction(transaction);
        }
      };
      stateRequest.onerror = () => {
        failure =
          stateRequest.error ?? new BrowserAppearanceStorageError("IndexedDB state read failed.");
        rejectTransaction(transaction);
      };
    });
  }

  private restoreState(
    database: BrowserIdbDatabase,
    previous: AppearancePersistedState | undefined,
    writtenRevision: number,
  ): Promise<void> {
    const transaction = database.transaction(
      [STATE_STORE, PACKAGES_STORE, CSS_STORE, ASSETS_STORE, DIAGNOSTICS_STORE],
      "readwrite",
    );
    let failure: Error | undefined;
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => (failure === undefined ? resolve() : reject(failure));
      transaction.onabort = () =>
        reject(failure ?? new BrowserAppearanceStorageError("State rollback aborted."));
      transaction.onerror = () =>
        reject(failure ?? new BrowserAppearanceStorageError("State rollback failed."));
      const stateStore = transaction.objectStore(STATE_STORE);
      const request = stateStore.get("current");
      request.onsuccess = () => {
        const current = request.result;
        const decoded = current === undefined ? null : decodeStoredState(current.value);
        if (decoded?.state.revision !== writtenRevision) return;
        stateStore.clear();
        transaction.objectStore(PACKAGES_STORE).clear();
        transaction.objectStore(CSS_STORE).clear();
        transaction.objectStore(ASSETS_STORE).clear();
        transaction.objectStore(DIAGNOSTICS_STORE).clear();
        if (previous !== undefined) {
          stateStore.put(record("current", encodeStoredState(previous)));
          this.writePackageRecords(transaction, previous);
          transaction
            .objectStore(DIAGNOSTICS_STORE)
            .put(record("state", JSON.stringify(previous.diagnostics)));
        }
      };
      request.onerror = () => {
        failure = request.error ?? new BrowserAppearanceStorageError("State rollback read failed.");
        rejectTransaction(transaction);
      };
    });
  }

  private writePackageRecords(
    transaction: BrowserIdbTransaction,
    state: AppearancePersistedState,
  ): void {
    const packageStore = transaction.objectStore(PACKAGES_STORE);
    const cssStore = transaction.objectStore(CSS_STORE);
    const assetStore = transaction.objectStore(ASSETS_STORE);
    for (const [id, packageValue] of Object.entries(state.packages)) {
      packageStore.put(record(id, packageJson(packageValue)));
      this.writePackageAssets(cssStore, assetStore, id, packageValue);
    }
    for (const [index, packageValue] of state.environmentPackages.entries()) {
      packageStore.put(record(`environment:${index}`, packageJson(packageValue)));
      this.writePackageAssets(cssStore, assetStore, `environment:${index}`, packageValue);
    }
    for (const snippet of state.snippets) {
      cssStore.put(record(`snippet:${snippet.id}`, snippet.css));
    }
  }

  private writePackageAssets(
    cssStore: BrowserIdbObjectStore,
    assetStore: BrowserIdbObjectStore,
    id: string,
    packageValue: AppearanceStoredPackage,
  ): void {
    if (packageValue.sharedCss !== undefined)
      cssStore.put(record(`${id}:shared-css`, packageValue.sharedCss));
    if (packageValue.desktopCss !== undefined)
      cssStore.put(record(`${id}:desktop-css`, packageValue.desktopCss));
    for (const asset of packageValue.assets) {
      assetStore.put(record(`${id}:asset:${asset.id}`, JSON.stringify(asset)));
    }
  }

  private waitForTransaction(
    transaction: BrowserIdbTransaction,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete.
        }
        reject(makeAbortError());
      };
      transaction.oncomplete = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      transaction.onabort = () =>
        reject(new BrowserAppearanceStorageError("IndexedDB transaction aborted."));
      transaction.onerror = () =>
        reject(new BrowserAppearanceStorageError("IndexedDB transaction failed."));
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private notify(state: AppearancePersistedState): void {
    if (state.revision <= this.emittedRevision) return;
    this.emittedRevision = state.revision;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A consumer cannot turn a durable commit into an apparent failure.
      }
    }
  }

  private publish(state: AppearancePersistedState): void {
    const message = JSON.stringify({ source: this.sourceId, revision: state.revision });
    try {
      this.broadcastChannel?.postMessage(message);
    } catch {
      // The storage-event path remains available when BroadcastChannel is unavailable.
    }
    try {
      this.localStorage?.setItem(APPEARANCE_BROADCAST_STORAGE_KEY, message);
    } catch {
      // Cross-tab synchronization is best effort; IndexedDB remains authoritative.
    }
  }

  private handleMessage(message: string): void {
    const parsed = parseJson(message);
    if (
      !isRecord(parsed) ||
      parsed.source === this.sourceId ||
      typeof parsed.revision !== "number" ||
      !Number.isSafeInteger(parsed.revision)
    )
      return;
    if (parsed.revision <= this.latestRevision) return;
    this.pendingRemoteRevision = Math.max(this.pendingRemoteRevision, parsed.revision);
    if (this.reconcileInFlight !== null) return;
    this.reconcileInFlight = this.reconcile().then((progressed) => {
      this.reconcileInFlight = null;
      if (progressed && this.pendingRemoteRevision > this.latestRevision) {
        this.handleMessage(
          JSON.stringify({ source: "remote", revision: this.pendingRemoteRevision }),
        );
      }
    });
  }

  private async reconcile(): Promise<boolean> {
    const before = this.latestRevision;
    try {
      const state = await this.load();
      const progressed = state.revision > before;
      if (progressed) this.notify(state);
      return progressed;
    } catch {
      // A later cross-tab event retries; never spin when IndexedDB is unavailable or corrupt.
      return false;
    }
  }
}
