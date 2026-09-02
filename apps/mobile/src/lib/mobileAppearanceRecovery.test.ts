import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { MobilePreferencesStore, Preferences } from "../persistence/mobile-preferences";

import {
  MOBILE_APPEARANCE_RESET_URL,
  MOBILE_APPEARANCE_SAFE_URL,
  createMobileAppearanceResetPatch,
  createMobileAppearanceRestorePatch,
  parseMobileAppearanceRecoveryUrl,
  resetMobileAppearance,
} from "./mobileAppearanceRecovery";

describe("parseMobileAppearanceRecoveryUrl", () => {
  it("recognizes exactly the safe and reset launch links", () => {
    expect(parseMobileAppearanceRecoveryUrl(MOBILE_APPEARANCE_SAFE_URL)).toBe("safe");
    expect(parseMobileAppearanceRecoveryUrl(MOBILE_APPEARANCE_RESET_URL)).toBe("reset");
  });

  it("recognizes recovery links for the configured product scheme", () => {
    expect(
      parseMobileAppearanceRecoveryUrl(
        "t3code-pi-omp-preview://appearance/safe",
        "t3code-pi-omp-preview",
      ),
    ).toBe("safe");
    expect(
      parseMobileAppearanceRecoveryUrl(
        "t3code-pi-omp-preview://appearance/reset",
        "t3code-pi-omp-preview",
      ),
    ).toBe("reset");
  });

  it("rejects lookalike links before custom appearance application", () => {
    for (const value of [
      "t3code://appearance/safe/",
      "t3code://appearance/safe?source=test",
      "t3code://appearance/reset#confirm",
      "t3code-dev://appearance/safe",
      null,
      undefined,
    ]) {
      expect(parseMobileAppearanceRecoveryUrl(value)).toBeNull();
    }
    expect(
      parseMobileAppearanceRecoveryUrl("t3code-pi-omp-preview://appearance/safe", "t3code-pi-omp"),
    ).toBeNull();
  });
});
describe("resetMobileAppearance", () => {
  it.effect("clears appearance through storage when the preferences atom is unavailable", () =>
    Effect.gen(function* () {
      let patch: Partial<Preferences> | undefined;
      const store: Pick<MobilePreferencesStore["Service"], "update"> = {
        update: (transform) => {
          patch = transform({});
          return Effect.succeed<Preferences>({});
        },
      };

      yield* resetMobileAppearance(store);

      expect(patch).toEqual({ appearanceProfile: undefined });
    }),
  );
});

describe("createMobileAppearanceResetPatch", () => {
  it("quarantines a portable profile before clearing it", () => {
    const profile = { metadata: { id: "portable" } };
    expect(createMobileAppearanceResetPatch(profile)).toEqual({
      appearanceProfile: undefined,
      quarantinedAppearanceProfile: profile,
    });
  });

  it("does not erase an existing quarantine when no active profile exists", () => {
    expect(createMobileAppearanceResetPatch(undefined)).toEqual({
      appearanceProfile: undefined,
    });
  });
});

describe("createMobileAppearanceRestorePatch", () => {
  it("restores the quarantine and swaps the current profile back into quarantine", () => {
    const current = { metadata: { id: "current" } };
    const quarantined = { metadata: { id: "quarantined" } };
    expect(createMobileAppearanceRestorePatch(current, quarantined)).toEqual({
      appearanceProfile: quarantined,
      quarantinedAppearanceProfile: current,
    });
  });
});
