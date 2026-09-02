import type * as Effect from "effect/Effect";
import type {
  MobilePreferencesSaveError,
  MobilePreferencesStore,
  Preferences,
} from "../persistence/mobile-preferences";

export const MOBILE_APPEARANCE_SAFE_URL = "t3code://appearance/safe" as const;
export const MOBILE_APPEARANCE_RESET_URL = "t3code://appearance/reset" as const;

export type MobileAppearanceRecoveryAction = "safe" | "reset";

/** Parse only the two documented recovery URLs before any custom appearance is mounted. */
export function parseMobileAppearanceRecoveryUrl(
  url: string | null | undefined,
  scheme = "t3code",
): MobileAppearanceRecoveryAction | null {
  if (url === `${scheme}://appearance/safe`) return "safe";
  if (url === `${scheme}://appearance/reset`) return "reset";
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

/**
 * Reset from the storage service's current value rather than the preferences atom.
 * Recovery remains usable when that atom is waiting or failed.
 */
export function resetMobileAppearance(
  store: Pick<MobilePreferencesStore["Service"], "update">,
): Effect.Effect<Preferences, MobilePreferencesSaveError> {
  return store.update(({ appearanceProfile }) =>
    createMobileAppearanceResetPatch(appearanceProfile),
  );
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
