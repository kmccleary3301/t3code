import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_APPEARANCE_RESET_URL,
  MOBILE_APPEARANCE_SAFE_URL,
  createMobileAppearanceResetPatch,
  createMobileAppearanceRestorePatch,
  parseMobileAppearanceRecoveryUrl,
} from "./mobileAppearanceRecovery";

describe("parseMobileAppearanceRecoveryUrl", () => {
  it("recognizes exactly the safe and reset launch links", () => {
    expect(parseMobileAppearanceRecoveryUrl(MOBILE_APPEARANCE_SAFE_URL)).toBe("safe");
    expect(parseMobileAppearanceRecoveryUrl(MOBILE_APPEARANCE_RESET_URL)).toBe("reset");
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
  });
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
