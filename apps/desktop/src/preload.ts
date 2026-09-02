import type {
  DesktopAppearanceWatchEvent,
  DesktopBridge,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewTabState,
} from "@t3tools/contracts";
import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
function isDesktopAppearanceWatchReason(
  reason: unknown,
): reason is DesktopAppearanceWatchEvent["reason"] {
  return (
    reason === "external-change" ||
    reason === "safe-mode" ||
    reason === "reset" ||
    reason === "install" ||
    reason === "transaction"
  );
}

function isDesktopAppearanceWatchEvent(value: unknown): value is DesktopAppearanceWatchEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as { readonly reason?: unknown; readonly state?: unknown };
  if (!isDesktopAppearanceWatchReason(event.reason)) return false;
  if (typeof event.state !== "object" || event.state === null) return false;
  const state = event.state as {
    readonly revision?: unknown;
    readonly safeMode?: unknown;
    readonly checksum?: unknown;
  };
  return (
    typeof state.revision === "number" &&
    Number.isSafeInteger(state.revision) &&
    state.revision >= 0 &&
    typeof state.safeMode === "boolean" &&
    typeof state.checksum === "string" &&
    /^[0-9a-f]{64}$/u.test(state.checksum)
  );
}

exposeClerkBridge({ passkeys: true });

// oxlint-disable-next-line t3code/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;

const APPEARANCE_STARTUP_READY_MESSAGE = "t3code:appearance-startup-ready";
const APPEARANCE_STARTUP_FAILED_MESSAGE = "t3code:appearance-startup-failed";
let appearanceStartupSettled = false;

function revealBuiltinAppearance(): void {
  const root = document.documentElement;
  const dark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("dark", dark);
  root.dataset.appearanceSafeMode = "true";
  delete root.dataset.themeId;
  delete root.dataset.t3AppearanceActive;
  root.style.removeProperty("color-scheme");
  root.style.removeProperty("background-color");
  document.body?.style.removeProperty("background-color");
  root.removeAttribute("data-appearance-startup");
  root.dataset.appearanceStartup = "recovery";
  document.querySelector<HTMLStyleElement>("style[data-t3-appearance-atomic]")?.remove();
  for (const name of Array.from({ length: root.style.length }, (_, index) =>
    root.style.item(index),
  )) {
    if (name.startsWith("--app-theme-") || name.startsWith("--t3-"))
      root.style.removeProperty(name);
  }
}

function detachAppearanceStartupFailureListeners(): void {
  window.removeEventListener("message", handleAppearanceStartupMessage);
  window.removeEventListener("unhandledrejection", reportAppearanceStartupFailure);
  window.removeEventListener("error", handleAppearanceStartupError);
}

function settleAppearanceStartup(channel: string): void {
  if (appearanceStartupSettled) return;
  appearanceStartupSettled = true;
  detachAppearanceStartupFailureListeners();
  ipcRenderer.send(channel);
}

function reportAppearanceStartupFailure(): void {
  if (appearanceStartupSettled) return;
  revealBuiltinAppearance();
  settleAppearanceStartup(IpcChannels.APPEARANCE_STARTUP_FAILED_CHANNEL);
}

function handleAppearanceStartupError(event: ErrorEvent): void {
  if (event.error !== undefined) reportAppearanceStartupFailure();
}

function handleAppearanceStartupMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  if (event.data === APPEARANCE_STARTUP_READY_MESSAGE) {
    settleAppearanceStartup(IpcChannels.APPEARANCE_STARTUP_READY_CHANNEL);
  } else if (event.data === APPEARANCE_STARTUP_FAILED_MESSAGE) {
    reportAppearanceStartupFailure();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", handleAppearanceStartupMessage);
  window.addEventListener("unhandledrejection", reportAppearanceStartupFailure);
  window.addEventListener("error", handleAppearanceStartupError);
}

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getClientPlatform: () => clientPlatform,
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getLocalEnvironmentBootstraps: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
    if (!Array.isArray(result)) {
      return [];
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstraps"]>;
  },
  getLocalEnvironmentBearerToken: () =>
    ipcRenderer.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  readAppearanceState: () =>
    ipcRenderer.invoke(IpcChannels.READ_APPEARANCE_STATE_CHANNEL, undefined),
  commitAppearanceState: (input) =>
    ipcRenderer.invoke(IpcChannels.COMMIT_APPEARANCE_STATE_CHANNEL, input),
  listAppearancePackages: () => ipcRenderer.invoke(IpcChannels.LIST_APPEARANCE_PACKAGES_CHANNEL),
  readAppearancePackage: (input) =>
    ipcRenderer.invoke(IpcChannels.READ_APPEARANCE_PACKAGE_CHANNEL, input),
  installAppearancePackage: () =>
    ipcRenderer.invoke(IpcChannels.INSTALL_APPEARANCE_PACKAGE_CHANNEL),
  exportAppearancePackage: (input) =>
    ipcRenderer.invoke(IpcChannels.EXPORT_APPEARANCE_PACKAGE_CHANNEL, input),
  startAppearanceWatch: () => ipcRenderer.invoke(IpcChannels.START_APPEARANCE_WATCH_CHANNEL),
  onAppearanceWatchEvent: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      try {
        if (isDesktopAppearanceWatchEvent(raw)) listener(raw);
      } catch {
        // Main-process payloads still cross an untrusted serialization boundary.
      }
    };
    ipcRenderer.on(IpcChannels.APPEARANCE_WATCH_EVENT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.APPEARANCE_WATCH_EVENT_CHANNEL, wrappedListener);
    };
  },
  revealAppearanceFolder: () => ipcRenderer.invoke(IpcChannels.REVEAL_APPEARANCE_FOLDER_CHANNEL),
  setAppearanceSafeMode: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_APPEARANCE_SAFE_MODE_CHANNEL, input),
  resetAppearance: () => ipcRenderer.invoke(IpcChannels.RESET_APPEARANCE_CHANNEL),
  readAppearanceQuarantine: () =>
    ipcRenderer.invoke(IpcChannels.READ_APPEARANCE_QUARANTINE_CHANNEL),
  restoreAppearanceQuarantine: () =>
    ipcRenderer.invoke(IpcChannels.RESTORE_APPEARANCE_QUARANTINE_CHANNEL),
  getConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) =>
    ipcRenderer.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  clearConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getWslState: () => ipcRenderer.invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => ipcRenderer.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => ipcRenderer.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickProjectFavicon: (initialPath) =>
    ipcRenderer.invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  pickThemeFiles: () => ipcRenderer.invoke(IpcChannels.PICK_THEME_FILES_CHANNEL, undefined),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  probeRemoteEditors: () => ipcRenderer.invoke(IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL, undefined),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  onQuitShortcut: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (state !== "down" && state !== "up") return;
      listener(state);
    };

    ipcRenderer.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    };
  },
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  preview: {
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    hardReload: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    clearCookies: () => ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL),
    clearCache: () => ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL),
    getPreviewConfig: (environmentId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    pickElement: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    copyArtifactToClipboard: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      startScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
      onFrame: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
          if (typeof frame !== "object" || frame === null) return;
          listener(frame as DesktopPreviewRecordingFrame);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
      },
    },
    automation: {
      status: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL, { tabId }),
      snapshot: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, { tabId }),
      click: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL, { tabId, input }),
      type: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL, { tabId, input }),
      press: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL, { tabId, input }),
      scroll: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL, { tabId, input }),
      evaluate: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL, { tabId, input }),
      waitFor: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL, { tabId, input }),
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as DesktopPreviewTabState);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, pointerEvent: unknown) => {
        if (typeof pointerEvent !== "object" || pointerEvent === null) return;
        listener(pointerEvent as DesktopPreviewPointerEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
    },
  },
} satisfies DesktopBridge);
