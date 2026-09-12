import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import {
  applyBuiltinAppearanceForStartup,
  initializeAppearanceStartup,
  revealAppearanceStartup,
} from "./appearanceRuntime";
import { clerkAppearance } from "./components/clerk/clerkAppearance";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function renderApp(): void {
  const app = <AppRoot router={router} />;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {clerkPublishableKey && hasCloudPublicConfig() ? (
        isElectron ? (
          <ElectronClerkProvider
            appearance={clerkAppearance}
            publishableKey={clerkPublishableKey}
            passkeys={passkeys}
          >
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          </ElectronClerkProvider>
        ) : (
          <ClerkProvider appearance={clerkAppearance} publishableKey={clerkPublishableKey}>
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          </ClerkProvider>
        )
      ) : (
        app
      )}
    </React.StrictMode>,
  );
}

void initializeAppearanceStartup()
  .then(() => {
    if (isElectron) window.postMessage("t3code:appearance-startup-ready", "*");
    renderApp();
  })
  .catch((error: unknown) => {
    // The initializer catches storage/compiler failures, but keep a final
    // fail-open path for module/runtime failures so the gate never locks out
    // the builtin recovery surface.
    applyBuiltinAppearanceForStartup();
    revealAppearanceStartup();
    if (isElectron) window.postMessage("t3code:appearance-startup-failed", "*");
    console.error("Appearance bootstrap failed unexpectedly.", error);
    renderApp();
  });
