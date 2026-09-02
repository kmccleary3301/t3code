import type { DesktopBridge } from "@t3tools/contracts";
import { appearanceSha256 } from "@t3tools/shared/appearance";

import type { AppearancePersistedState, AppearanceStorageAdapter } from "./model.ts";
import { decodeAppearancePersistedState } from "./model.ts";

export type DesktopAppearanceStateBridge = Pick<
  DesktopBridge,
  "readAppearanceState" | "commitAppearanceState" | "onAppearanceWatchEvent"
> &
  Partial<
    Pick<
      DesktopBridge,
      "resetAppearance" | "readAppearanceQuarantine" | "restoreAppearanceQuarantine"
    >
  >;

/** Validated renderer-side adapter for the main-process desktop appearance store. */
export class DesktopBridgeAppearanceStorage implements AppearanceStorageAdapter {
  private readonly bridge: DesktopAppearanceStateBridge;

  constructor(bridge: DesktopAppearanceStateBridge) {
    this.bridge = bridge;
  }

  readonly load = async (): Promise<AppearancePersistedState> => {
    const document = await this.bridge.readAppearanceState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.stateJson);
    } catch {
      throw new Error("Desktop appearance state JSON is malformed.");
    }
    const state = decodeAppearancePersistedState(parsed);
    if (state === null || appearanceSha256(state) !== document.checksum) {
      throw new Error("Desktop appearance state failed schema or checksum validation.");
    }
    return state;
  };

  readonly commit = async (
    expectedRevision: number,
    state: AppearancePersistedState,
  ): Promise<void> => {
    const checksum = appearanceSha256(state);
    const summary = await this.bridge.commitAppearanceState({
      expectedRevision,
      stateJson: JSON.stringify(state),
      checksum,
    });
    if (summary.revision !== state.revision || summary.checksum !== checksum) {
      throw new Error("Desktop appearance commit acknowledgement does not match the state.");
    }
  };

  readonly recover = async (
    requested: AppearancePersistedState,
  ): Promise<AppearancePersistedState> => {
    const resetAppearance = this.bridge.resetAppearance;
    if (resetAppearance === undefined) throw new Error("Desktop appearance reset is unavailable.");
    let existing: AppearancePersistedState | null = null;
    try {
      existing = await this.load();
    } catch {
      // Reset is the durable fallback for a corrupt state document.
    }
    const summary =
      existing?.safeMode === true
        ? {
            revision: existing.revision,
            safeMode: true,
            checksum: appearanceSha256(existing),
          }
        : await resetAppearance();
    let authoritative = await this.load();
    if (
      authoritative.revision < summary.revision ||
      (authoritative.revision === summary.revision &&
        appearanceSha256(authoritative) !== summary.checksum)
    ) {
      throw new Error("Desktop appearance reset acknowledgement does not match durable state.");
    }
    const safeState = {
      ...authoritative,
      safeMode: true,
      diagnostics: [...authoritative.diagnostics, ...requested.diagnostics].slice(-1024),
    };
    if (
      !authoritative.safeMode ||
      appearanceSha256(authoritative.diagnostics) !== appearanceSha256(safeState.diagnostics)
    ) {
      await this.commit(authoritative.revision, {
        ...safeState,
        revision: authoritative.revision + 1,
      });
      authoritative = await this.load();
    }
    return authoritative;
  };
  readonly readQuarantinedState = async (): Promise<AppearancePersistedState | null> => {
    const read = this.bridge.readAppearanceQuarantine;
    if (read === undefined) return null;
    const document = await read();
    if (document === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.stateJson);
    } catch {
      throw new Error("Desktop appearance quarantine JSON is malformed.");
    }
    const state = decodeAppearancePersistedState(parsed);
    if (state === null || appearanceSha256(state) !== document.checksum) {
      throw new Error("Desktop appearance quarantine failed schema or checksum validation.");
    }
    return state;
  };

  readonly restoreQuarantinedState = async (): Promise<AppearancePersistedState> => {
    const restore = this.bridge.restoreAppearanceQuarantine;
    if (restore === undefined)
      throw new Error("Desktop appearance quarantine restore is unavailable.");
    const summary = await restore();
    const authoritative = await this.load();
    if (
      authoritative.revision !== summary.revision ||
      appearanceSha256(authoritative) !== summary.checksum
    ) {
      throw new Error("Desktop appearance quarantine restore acknowledgement is invalid.");
    }
    return authoritative;
  };

  readonly subscribe = (listener: (state: AppearancePersistedState) => void): (() => void) => {
    let active = true;
    const unsubscribe = this.bridge.onAppearanceWatchEvent(() => {
      if (!active) return;
      void this.load().then(
        (state) => {
          if (active) listener(state);
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  };
}
