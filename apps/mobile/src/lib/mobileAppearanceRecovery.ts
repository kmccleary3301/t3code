export const MOBILE_APPEARANCE_SAFE_URL = "t3code://appearance/safe" as const;
export const MOBILE_APPEARANCE_RESET_URL = "t3code://appearance/reset" as const;

export type MobileAppearanceRecoveryAction = "safe" | "reset";

/** Parse only the two documented recovery URLs before any custom appearance is mounted. */
export function parseMobileAppearanceRecoveryUrl(
  url: string | null | undefined,
): MobileAppearanceRecoveryAction | null {
  if (url === MOBILE_APPEARANCE_SAFE_URL) return "safe";
  if (url === MOBILE_APPEARANCE_RESET_URL) return "reset";
  return null;
}

export function createMobileAppearanceResetPatch<T>(profile: T | undefined): {
  readonly appearanceProfile: undefined;
  readonly quarantinedAppearanceProfile?: T;
} {
  return profile === undefined
    ? { appearanceProfile: undefined }
    : { appearanceProfile: undefined, quarantinedAppearanceProfile: profile };
}

export function createMobileAppearanceRestorePatch<T>(
  profile: T | undefined,
  quarantinedProfile: T,
): {
  readonly appearanceProfile: T;
  readonly quarantinedAppearanceProfile: T | undefined;
} {
  return {
    appearanceProfile: quarantinedProfile,
    quarantinedAppearanceProfile: profile,
  };
}
