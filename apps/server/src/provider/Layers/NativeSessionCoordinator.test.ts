import { describe, expect, it } from "vite-plus/test";

import { nativeThreadHasActiveTurn } from "./NativeSessionCoordinator.ts";

describe("nativeThreadHasActiveTurn", () => {
  it("blocks archive while a native turn is running", () => {
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "running", activeTurnId: "turn-1" },
      }),
    ).toBe(true);
  });

  it("allows archive when no turn is active", () => {
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "running", activeTurnId: null },
      }),
    ).toBe(false);
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "ready", activeTurnId: "stale-turn" },
      }),
    ).toBe(false);
    expect(
      nativeThreadHasActiveTurn({
        session: { status: "running", activeTurnId: undefined },
      }),
    ).toBe(false);
    expect(nativeThreadHasActiveTurn({ session: null })).toBe(false);
    expect(nativeThreadHasActiveTurn(undefined)).toBe(false);
  });
});
