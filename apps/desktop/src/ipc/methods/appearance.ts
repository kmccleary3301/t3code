import {
  DesktopAppearanceCommitInputSchema,
  DesktopAppearanceExportInputSchema,
  DesktopAppearancePackageDocumentSchema,
  DesktopAppearancePackageSummarySchema,
  DesktopAppearanceReadInputSchema,
  DesktopAppearanceSafeModeInputSchema,
  DesktopAppearanceStateDocumentSchema,
  DesktopAppearanceStateSummarySchema,
  type DesktopAppearancePackageDocument,
  type DesktopAppearancePackageSummary,
  type DesktopAppearanceStateDocument,
  type DesktopAppearanceStateSummary,
  type DesktopAppearanceWatchEvent,
} from "@t3tools/contracts";
import {
  decodeAppearancePersistedState,
  type AppearancePersistedState,
} from "@t3tools/client-runtime/appearance";
import { appearanceSha256 } from "@t3tools/shared/appearance";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  DesktopAppearanceStorage,
  isNarrowSafeRecoveryMutation,
} from "../../appearance/DesktopAppearanceStorage.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const storageByRoot = new Map<string, DesktopAppearanceStorage>();
const watchStopsByRoot = new Map<string, () => void>();

function storageFor(
  root: string,
  appVersion: string,
  platform: NodeJS.Platform,
): DesktopAppearanceStorage {
  const existing = storageByRoot.get(root);
  if (existing !== undefined) return existing;
  const storage = new DesktopAppearanceStorage(root, appVersion, platform);
  storageByRoot.set(root, storage);
  return storage;
}

function startWatch(
  root: string,
  storage: DesktopAppearanceStorage,
  electronWindow: ElectronWindow.ElectronWindow["Service"],
): void {
  if (watchStopsByRoot.has(root)) return;
  const stop = storage.watch((state) => publish(electronWindow, "external-change", state));
  watchStopsByRoot.set(root, stop);
}

function stopWatch(root: string): void {
  const stop = watchStopsByRoot.get(root);
  if (stop === undefined) return;
  watchStopsByRoot.delete(root);
  stop();
}

function stateSummary(
  state: Awaited<ReturnType<DesktopAppearanceStorage["load"]>>,
): DesktopAppearanceStateSummary {
  return {
    revision: state.revision,
    safeMode: state.safeMode,
    checksum: appearanceSha256(state),
  };
}

function packageSummary(
  value: NonNullable<Awaited<ReturnType<DesktopAppearanceStorage["read"]>>>,
  order: readonly string[],
): DesktopAppearancePackageSummary {
  return {
    id: value.manifest.metadata.id,
    name: value.manifest.metadata.name,
    version: value.manifest.metadata.version,
    enabled: value.enabled,
    order: Math.max(0, order.indexOf(value.manifest.metadata.id)),
    manifestHash: value.manifestHash,
    diagnosticCount: value.diagnostics.length,
    quarantined: false,
  };
}

function packageDocument(
  value: NonNullable<Awaited<ReturnType<DesktopAppearanceStorage["read"]>>>,
  order: readonly string[],
): DesktopAppearancePackageDocument {
  return {
    summary: packageSummary(value, order),
    capabilities: [...value.profile.capabilities],
    manifestJson: JSON.stringify(value.manifest),
    sharedCss: value.sharedCss ?? null,
    desktopCss: value.desktopCss ?? null,
    assets: value.assets.map(({ dataBase64: _dataBase64, ...asset }) => asset),
  };
}

function stateDocument(state: AppearancePersistedState): DesktopAppearanceStateDocument {
  return {
    stateJson: JSON.stringify(state),
    checksum: appearanceSha256(state),
  };
}

function decodeStateJson(stateJson: string): AppearancePersistedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    throw new Error("Appearance state JSON is malformed.");
  }
  const state = decodeAppearancePersistedState(parsed);
  if (state === null) throw new Error("Appearance state does not match the persisted schema.");
  return state;
}

function decodeCommittedState(stateJson: string, checksum: string): AppearancePersistedState {
  const state = decodeStateJson(stateJson);
  if (appearanceSha256(state) !== checksum) {
    throw new Error("Appearance state checksum does not match the decoded state.");
  }
  return state;
}

function isExplicitRecoveryReset(
  current: AppearancePersistedState,
  candidate: AppearancePersistedState,
): boolean {
  return (
    candidate.revision === current.revision + 1 &&
    Object.keys(candidate.packages).length === 0 &&
    candidate.order.length === 0 &&
    candidate.preference.mode === "system" &&
    Object.keys(candidate.preference).length === 1 &&
    candidate.typographyPreference === undefined &&
    candidate.snippets.length === 0 &&
    Object.keys(candidate.accessibility).length === 0 &&
    !candidate.safeMode &&
    candidate.environmentPackages.length === 0 &&
    candidate.diagnostics.length === 0 &&
    candidate.migration.completed
  );
}

function storeEffect<A>(operation: () => Promise<A>): Effect.Effect<A> {
  return Effect.promise(operation);
}

function publish(
  electronWindow: ElectronWindow.ElectronWindow["Service"],
  reason: DesktopAppearanceWatchEvent["reason"],
  state: Awaited<ReturnType<DesktopAppearanceStorage["load"]>>,
): void {
  const event: DesktopAppearanceWatchEvent = { reason, state: stateSummary(state) };
  void Effect.runPromise(electronWindow.sendAll(IpcChannels.APPEARANCE_WATCH_EVENT_CHANNEL, event));
}

function services() {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const platform = yield* HostProcessPlatform;
    return {
      storage: storageFor(environment.stateDir, environment.appVersion, platform),
      environment,
    };
  });
}

export const readAppearanceState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_APPEARANCE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopAppearanceStateDocumentSchema,
  handler: Effect.fn("desktop.ipc.appearance.readState")(function* () {
    const { storage } = yield* services();
    const state = yield* storeEffect(() => storage.load());
    return stateDocument(state);
  }),
});

export const commitAppearanceState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMMIT_APPEARANCE_STATE_CHANNEL,
  payload: DesktopAppearanceCommitInputSchema,
  result: DesktopAppearanceStateSummarySchema,
  handler: Effect.fn("desktop.ipc.appearance.commitState")(function* ({
    expectedRevision,
    stateJson,
    checksum,
  }) {
    const { storage } = yield* services();
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const current = yield* storeEffect(() => storage.load());
    const state = decodeCommittedState(stateJson, checksum);
    if (
      current.safeMode &&
      !isExplicitRecoveryReset(current, state) &&
      !isNarrowSafeRecoveryMutation(current, state)
    ) {
      throw new Error("Appearance mutation is disabled while safe mode is active.");
    }
    yield* storeEffect(() => storage.commit(expectedRevision, state));
    publish(electronWindow, "transaction", state);
    return stateSummary(state);
  }),
});

export const listAppearancePackages = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_APPEARANCE_PACKAGES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopAppearancePackageSummarySchema),
  handler: Effect.fn("desktop.ipc.appearance.list")(function* () {
    const { storage } = yield* services();
    const state = yield* storeEffect(() => storage.load());
    return Object.values(state.packages).map((value) => packageSummary(value, state.order));
  }),
});

export const readAppearancePackage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_APPEARANCE_PACKAGE_CHANNEL,
  payload: DesktopAppearanceReadInputSchema,
  result: Schema.NullOr(DesktopAppearancePackageDocumentSchema),
  handler: Effect.fn("desktop.ipc.appearance.read")(function* ({ id }) {
    const { storage } = yield* services();
    const state = yield* storeEffect(() => storage.load());
    const value = state.packages[id];
    return value === undefined ? null : packageDocument(value, state.order);
  }),
});

export const installAppearancePackage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALL_APPEARANCE_PACKAGE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopAppearancePackageSummarySchema),
  handler: Effect.fn("desktop.ipc.appearance.install")(function* () {
    const { storage } = yield* services();
    const current = yield* storeEffect(() => storage.load());
    if (current.safeMode) {
      throw new Error("Appearance package installation is disabled while safe mode is active.");
    }
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const owner = yield* electronWindow.focusedMainOrFirst;
    const files = yield* dialog.pickFiles({
      owner,
      defaultPath: Option.none(),
      multiple: false,
      filters: [{ name: "T3 appearance package", extensions: ["zip", "t3appearance"] }],
    });
    const source =
      files[0] ??
      Option.getOrUndefined(
        yield* dialog.pickFolder({
          owner,
          defaultPath: Option.none(),
        }),
      );
    if (source === undefined) return null;
    const value = yield* storeEffect(() => storage.install(source));
    const state = yield* storeEffect(() => storage.load());
    publish(electronWindow, "install", state);
    return packageSummary(value, state.order);
  }),
});

export const exportAppearancePackage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXPORT_APPEARANCE_PACKAGE_CHANNEL,
  payload: DesktopAppearanceExportInputSchema,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.appearance.export")(function* ({ id }) {
    const { storage, environment } = yield* services();
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const destination = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: Option.some(environment.stateDir),
    });
    if (Option.isNone(destination)) return null;
    const outputPath = environment.path.join(destination.value, `${id}.t3appearance.json`);
    return yield* storeEffect(() => storage.export(id, outputPath));
  }),
});

export const startAppearanceWatch = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_APPEARANCE_WATCH_CHANNEL,
  payload: Schema.Void,
  result: DesktopAppearanceStateSummarySchema,
  handler: Effect.fn("desktop.ipc.appearance.watch")(function* () {
    const { storage, environment } = yield* services();
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const state = yield* storeEffect(() => storage.load());
    if (state.safeMode) stopWatch(environment.stateDir);
    else startWatch(environment.stateDir, storage, electronWindow);
    return stateSummary(state);
  }),
});

export const revealAppearanceFolder = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REVEAL_APPEARANCE_FOLDER_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appearance.reveal")(function* () {
    const { storage } = yield* services();
    yield* storeEffect(() => storage.load());
    yield* Effect.promise(() => Electron.shell.openPath(storage.revealPath()));
  }),
});

export const setAppearanceSafeMode = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_APPEARANCE_SAFE_MODE_CHANNEL,
  payload: DesktopAppearanceSafeModeInputSchema,
  result: DesktopAppearanceStateSummarySchema,
  handler: Effect.fn("desktop.ipc.appearance.safeMode")(function* ({ enabled }) {
    const { storage, environment } = yield* services();
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const state = yield* storeEffect(() => storage.setSafeMode(enabled));
    if (enabled) stopWatch(environment.stateDir);
    else startWatch(environment.stateDir, storage, electronWindow);
    publish(electronWindow, "safe-mode", state);
    return stateSummary(state);
  }),
});

export const resetAppearance = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESET_APPEARANCE_CHANNEL,
  payload: Schema.Void,
  result: DesktopAppearanceStateSummarySchema,
  handler: Effect.fn("desktop.ipc.appearance.reset")(function* () {
    const { storage, environment } = yield* services();
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const state = yield* storeEffect(() => storage.reset());
    startWatch(environment.stateDir, storage, electronWindow);
    publish(electronWindow, "reset", state);
    return stateSummary(state);
  }),
});

export const readAppearanceQuarantine = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_APPEARANCE_QUARANTINE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopAppearanceStateDocumentSchema),
  handler: Effect.fn("desktop.ipc.appearance.readQuarantine")(function* () {
    const { storage } = yield* services();
    const state = yield* storeEffect(() => storage.readQuarantinedState());
    return state === null ? null : stateDocument(state);
  }),
});

export const restoreAppearanceQuarantine = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTORE_APPEARANCE_QUARANTINE_CHANNEL,
  payload: Schema.Void,
  result: DesktopAppearanceStateSummarySchema,
  handler: Effect.fn("desktop.ipc.appearance.restoreQuarantine")(function* () {
    const { storage, environment } = yield* services();
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const state = yield* storeEffect(() => storage.restoreQuarantinedState());
    startWatch(environment.stateDir, storage, electronWindow);
    publish(electronWindow, "reset", state);
    return stateSummary(state);
  }),
});

export const appearanceMethods = [
  readAppearanceState,
  commitAppearanceState,
  listAppearancePackages,
  readAppearancePackage,
  installAppearancePackage,
  exportAppearancePackage,
  startAppearanceWatch,
  revealAppearanceFolder,
  setAppearanceSafeMode,
  resetAppearance,
  readAppearanceQuarantine,
  restoreAppearanceQuarantine,
] as const;
