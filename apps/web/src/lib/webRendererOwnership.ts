/** Ownership boundaries for appearance propagation. No entry permits styling a remote page. */
export const WEB_RENDERER_OWNERSHIP = {
  clerkPortal: "clerk-portal",
  pierreShadowRoot: "pierre-shadow-root",
  pierreWorker: "pierre-worker",
  ghosttyCanvas: "ghostty-canvas",
  previewIsolatedDocument: "preview-isolated-document",
} as const;

export type WebRendererOwner = (typeof WEB_RENDERER_OWNERSHIP)[keyof typeof WEB_RENDERER_OWNERSHIP];
