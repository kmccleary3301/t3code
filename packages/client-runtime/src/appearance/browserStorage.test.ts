import { describe, expect, it } from "@effect/vitest";
import { normalizeAppearance } from "@t3tools/shared/appearance";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";

import type {
  BrowserAppearanceStorageOptions,
  BrowserBroadcastChannel,
  BrowserBroadcastMessageEvent,
  BrowserIdbDatabase,
  BrowserIdbObjectStore,
  BrowserIdbOpenRequest,
  BrowserIdbRecord,
  BrowserIdbRequest,
  BrowserIdbTransaction,
  BrowserIndexedDbFactory,
  BrowserLocalStorage,
  BrowserStorageEvent,
  BrowserStorageEventSource,
} from "./browserStorage.ts";
import {
  APPEARANCE_BOOT_STORAGE_KEY,
  BrowserAppearanceStorage,
  readAppearanceBootSnapshot,
} from "./browserStorage.ts";
import { createAppearanceRuntime } from "./runtime.ts";
import type { AppearancePersistedState } from "./model.ts";

const makeState = (revision: number): AppearancePersistedState => ({
  revision,
  packages: {},
  order: [],
  preference: { mode: "light" },
  snippets: [],
  accessibility: {},
  safeMode: false,
  environmentPackages: [],
  diagnostics: [],
  migration: { completed: true, sourceVersion: 2 },
});

class MemoryLocalStorage implements BrowserLocalStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("quota");
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class MemoryEvents implements BrowserStorageEventSource {
  readonly listeners = new Set<(event: BrowserStorageEvent) => void>();

  subscribe(listener: (event: BrowserStorageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: string): void {
    for (const listener of this.listeners)
      listener({ key: "t3code:appearance:changed:v1", newValue: value });
  }
}

class MemoryRequest<T> implements BrowserIdbRequest<T> {
  result: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(result: T, complete: () => void) {
    this.result = result;
    setTimeout(() => {
      try {
        this.onsuccess?.(new Event("success"));
      } finally {
        complete();
      }
    }, 0);
  }
}

class MemoryStore implements BrowserIdbObjectStore {
  private readonly values: Map<string, BrowserIdbRecord>;
  private readonly transaction: MemoryTransaction;

  constructor(values: Map<string, BrowserIdbRecord>, transaction: MemoryTransaction) {
    this.values = values;
    this.transaction = transaction;
  }

  get(key: string): BrowserIdbRequest<BrowserIdbRecord | undefined> {
    return this.transaction.request(() => this.values.get(key));
  }

  put(value: BrowserIdbRecord): BrowserIdbRequest<void> {
    this.values.set(value.key, value);
    return this.transaction.request(() => undefined);
  }

  delete(key: string): BrowserIdbRequest<void> {
    this.values.delete(key);
    return this.transaction.request(() => undefined);
  }

  clear(): BrowserIdbRequest<void> {
    this.values.clear();
    return this.transaction.request(() => undefined);
  }
}

class MemoryTransaction implements BrowserIdbTransaction {
  private pending = 0;
  private completeQueued = false;
  oncomplete: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly stores: Map<string, Map<string, BrowserIdbRecord>>;

  constructor(stores: Map<string, Map<string, BrowserIdbRecord>>) {
    this.stores = stores;
  }

  objectStore(name: string): BrowserIdbObjectStore {
    const values = this.stores.get(name);
    if (values === undefined) throw new Error(`missing store ${name}`);
    return new MemoryStore(values, this);
  }

  request<T>(read: () => T): BrowserIdbRequest<T> {
    this.pending += 1;
    return new MemoryRequest(read(), () => {
      this.pending -= 1;
      this.maybeComplete();
    });
  }

  abort(): void {
    this.onabort?.(new Event("abort"));
  }

  private maybeComplete(): void {
    if (this.pending !== 0 || this.completeQueued) return;
    this.completeQueued = true;
    setTimeout(() => this.oncomplete?.(new Event("complete")), 0);
  }
}

class MemoryDatabase implements BrowserIdbDatabase {
  readonly stores = new Map<string, Map<string, BrowserIdbRecord>>();

  transaction(
    names: ReadonlyArray<string>,
    _mode: "readonly" | "readwrite",
  ): BrowserIdbTransaction {
    for (const name of names) if (!this.stores.has(name)) this.stores.set(name, new Map());
    return new MemoryTransaction(this.stores);
  }

  createObjectStore(name: string): void {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
  }

  close(): void {}
}

class MemoryOpenRequest implements BrowserIdbOpenRequest {
  result: BrowserIdbDatabase;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: { oldVersion: number }) => void) | null = null;

  constructor(database: BrowserIdbDatabase) {
    this.result = database;
    setTimeout(() => {
      this.onupgradeneeded?.({ oldVersion: 0 });
      this.onsuccess?.(new Event("success"));
    }, 0);
  }
}

class MemoryIndexedDb implements BrowserIndexedDbFactory {
  readonly database = new MemoryDatabase();

  open(_name: string, _version: number): BrowserIdbOpenRequest {
    return new MemoryOpenRequest(this.database);
  }
}

class MemoryChannel implements BrowserBroadcastChannel {
  private readonly channels: Set<MemoryChannel>;

  constructor(channels: Set<MemoryChannel>) {
    this.channels = channels;
    channels.add(this);
  }
  readonly listeners = new Set<(event: BrowserBroadcastMessageEvent) => void>();

  postMessage(message: string): void {
    for (const channel of this.channels) {
      for (const listener of channel.listeners) listener({ data: message });
    }
  }

  addEventListener(
    _type: "message",
    listener: (event: BrowserBroadcastMessageEvent) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: BrowserBroadcastMessageEvent) => void,
  ): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.channels.delete(this);
  }
}

function options(
  idb: MemoryIndexedDb,
  storage: MemoryLocalStorage,
  events: MemoryEvents,
  channels: Set<MemoryChannel>,
  initialState: AppearancePersistedState,
): BrowserAppearanceStorageOptions {
  return {
    indexedDBFactory: idb,
    localStorageFactory: () => storage,
    storageEventSourceFactory: () => events,
    broadcastChannelFactory: () => new MemoryChannel(channels),
    initialState,
  };
}

describe("BrowserAppearanceStorage", () => {
  it("commits all stores before publishing a bounded boot snapshot", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );

    await adapter.commit(0, makeState(1));

    expect(await adapter.load()).toMatchObject({ revision: 1 });
    expect(readAppearanceBootSnapshot(storage)).toMatchObject({ revision: 1, mode: "light" });
    expect(idb.database.stores.has("state")).toBe(true);
    expect(idb.database.stores.has("packages")).toBe(true);
    expect(idb.database.stores.has("css")).toBe(true);
    expect(idb.database.stores.has("assets")).toBe(true);
    expect(idb.database.stores.has("diagnostics")).toBe(true);
    const encodedBoot = storage.getItem(APPEARANCE_BOOT_STORAGE_KEY);
    if (encodedBoot === null) throw new Error("missing boot snapshot");
    const tampered = JSON.parse(encodedBoot) as { checksum: string };
    tampered.checksum = "00000000";
    storage.values.set(APPEARANCE_BOOT_STORAGE_KEY, JSON.stringify(tampered));
    expect(readAppearanceBootSnapshot(storage)).toBeNull();
    adapter.close();
  });

  it("rejects schema-valid state changes whose durable checksum no longer matches", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await adapter.commit(0, makeState(1));
    const stateStore = idb.database.stores.get("state");
    const record = stateStore?.get("current");
    if (stateStore === undefined || record === undefined) throw new Error("missing state record");
    const document = JSON.parse(record.value) as {
      state: AppearancePersistedState;
      checksum: string;
    };
    document.state = { ...document.state, preference: { mode: "dark" } };
    stateStore.set("current", { key: "current", value: JSON.stringify(document) });

    const corrupted = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await expect(corrupted.load()).rejects.toThrow("schema validation");
    await expect(corrupted.recover(makeState(1))).resolves.toMatchObject({ revision: 2 });
    await expect(corrupted.load()).resolves.toMatchObject({ revision: 2 });
    adapter.close();
    corrupted.close();
  });
  it("quarantines and restores the last valid state across reset", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await adapter.commit(0, { ...makeState(1), preference: { mode: "dark" } });
    await expect(adapter.recover(makeState(2))).resolves.toMatchObject({ revision: 2 });
    await expect(adapter.readQuarantinedState()).resolves.toMatchObject({
      revision: 1,
      preference: { mode: "dark" },
    });
    await expect(adapter.restoreQuarantinedState()).resolves.toMatchObject({
      revision: 3,
      preference: { mode: "dark" },
    });
    await expect(adapter.readQuarantinedState()).resolves.toBeNull();
    adapter.close();
  });

  it("upgrades a legacy raw state record to the checksummed envelope on load", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const seed = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await seed.load();
    const stateStore = idb.database.stores.get("state");
    if (stateStore === undefined) throw new Error("missing state store");
    stateStore.set("current", {
      key: "current",
      value: JSON.stringify(makeState(1)),
    });

    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await expect(adapter.load()).resolves.toMatchObject({ revision: 1 });
    const upgraded = stateStore.get("current");
    if (upgraded === undefined) throw new Error("missing upgraded state");
    expect(JSON.parse(upgraded.value)).toMatchObject({
      version: 1,
      state: { revision: 1 },
      checksum: expect.any(String),
    });
    seed.close();
    adapter.close();
  });

  it("isolates listeners after IndexedDB and boot state commit", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    const revisions: number[] = [];
    adapter.subscribe(() => {
      throw new Error("listener failed");
    });
    adapter.subscribe((next) => revisions.push(next.revision));

    await expect(adapter.commit(0, makeState(1))).resolves.toBeUndefined();
    expect(revisions).toEqual([1]);
    expect((await adapter.load()).revision).toBe(1);
    adapter.close();
  });

  it("keeps the prior IDB state and boot snapshot when boot persistence fails", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await adapter.commit(0, makeState(1));
    const previousBoot = storage.getItem(APPEARANCE_BOOT_STORAGE_KEY);
    storage.failWrites = true;

    await expect(adapter.commit(1, makeState(2))).rejects.toThrow();
    expect(await adapter.load()).toMatchObject({ revision: 1 });
    expect(storage.getItem(APPEARANCE_BOOT_STORAGE_KEY)).toBe(previousBoot);
    adapter.close();
  });

  it("ignores corrupt and oversized boot snapshots", () => {
    const storage = new MemoryLocalStorage();
    storage.values.set(APPEARANCE_BOOT_STORAGE_KEY, '{"version":1}');
    expect(readAppearanceBootSnapshot(storage)).toBeNull();
    storage.values.set(APPEARANCE_BOOT_STORAGE_KEY, "x".repeat(9 * 1024));
    expect(readAppearanceBootSnapshot(storage)).toBeNull();
  });

  it("deduplicates same-revision cross-tab notifications", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const first = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    const second = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    const revisions: number[] = [];
    second.subscribe((state) => revisions.push(state.revision));
    await first.commit(0, makeState(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.emit(JSON.stringify({ source: "other", revision: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(revisions).toEqual([1]);
    first.close();
    second.close();
  });
  it("stops reconciling after a corrupt remote read and recovers on a later event", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    await adapter.load();
    const stateStore = idb.database.stores.get("state");
    if (stateStore === undefined) throw new Error("missing state store");
    stateStore.set("current", { key: "current", value: "{" });
    const revisions: number[] = [];
    adapter.subscribe((state) => revisions.push(state.revision));

    events.emit(JSON.stringify({ source: "other", revision: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revisions).toEqual([]);

    stateStore.set("current", { key: "current", value: JSON.stringify(makeState(1)) });
    events.emit(JSON.stringify({ source: "other", revision: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(revisions).toEqual([1]);
    adapter.close();
  });

  it("uses requested fixed modes and records the resolved system appearance", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    const runtime = await createAppearanceRuntime({
      storage: adapter,
      compiler: {
        normalize: (input, options) => normalizeAppearance(input, options),
        compile: async (input) => ({ input, artifact: "" }),
      },
      apply: { apply: async () => undefined },
    });
    expect(
      (
        await runtime.execute({
          type: "install",
          package: { input: T3_CHAT_THEME, sourceId: T3_CHAT_THEME.id },
        })
      ).status,
    ).toBe("applied");
    expect(
      (
        await runtime.execute({
          type: "preference",
          preference: {
            mode: "dark",
            packageId: T3_CHAT_THEME.id,
            variantId: "removed-variant",
          },
        })
      ).status,
    ).toBe("applied");

    const boot = readAppearanceBootSnapshot(storage);
    expect(boot?.mode).toBe("dark");
    expect(boot?.colorVariables["--app-theme-canvas"]).toBe(T3_CHAT_THEME.variants?.dark?.canvas);

    expect(
      (
        await runtime.execute({
          type: "preference",
          preference: {
            mode: "system",
            packageId: T3_CHAT_THEME.id,
            variantId: "dark",
          },
        })
      ).status,
    ).toBe("applied");
    const systemBoot = readAppearanceBootSnapshot(storage);
    expect(systemBoot?.mode).toBe("system");
    expect(systemBoot?.systemAppearance).toBe("dark");
    expect(systemBoot?.themeId).toBe(T3_CHAT_THEME.id);
    expect(systemBoot?.colorVariables["--app-theme-canvas"]).toBe(
      T3_CHAT_THEME.variants?.dark?.canvas,
    );
    adapter.close();
  });

  it("keeps only bounded explicit layers in the safe-mode boot cache", async () => {
    const idb = new MemoryIndexedDb();
    const storage = new MemoryLocalStorage();
    const events = new MemoryEvents();
    const channels = new Set<MemoryChannel>();
    const adapter = new BrowserAppearanceStorage(
      options(idb, storage, events, channels, makeState(0)),
    );
    const safeState = {
      ...makeState(1),
      preference: {
        mode: "dark" as const,
        overrides: {
          canvas: "#123456",
          customBrand: "#abcdef",
          "--t3-color-brand": "#fedcba",
        },
      },
      accessibility: { foreground: "#ffffff" },
      safeMode: true,
    };
    await adapter.commit(0, safeState);
    expect(readAppearanceBootSnapshot(storage)).toMatchObject({
      safeMode: true,
      mode: "system",
      colorVariables: {
        "--app-theme-canvas": "#123456",
        "--t3-color-brand": "#fedcba",
        "--t3-custom-brand": "#abcdef",
        "--t3-foreground": "#ffffff",
      },
    });
    adapter.close();
  });
});
