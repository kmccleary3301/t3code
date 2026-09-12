import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import legacyThemeVariables from "../../generated-uniwind-legacy-theme-variables.json";

import {
  getMobileThemeVariables,
  isDefaultMobileThemeId,
  isLegacyMobileThemeId,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";

const defaults = defaultThemeVariables as Readonly<
  Record<MobileThemeAppearance, MobileThemeVariables>
>;
const legacyDefaults = legacyThemeVariables as Readonly<
  Record<MobileThemeAppearance, MobileThemeVariables>
>;

export type MobileRuntimeVariables = Readonly<Record<string, string | number>>;

/**
 * Complete palette for native and third-party APIs that cannot consume a
 * Uniwind className. The standard palette is generated from global.css; custom
 * palettes share the same source that generates their registered CSS themes.
 */
export function getMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  return isLegacyMobileThemeId(themeId)
    ? legacyDefaults[appearance]
    : isDefaultMobileThemeId(themeId)
      ? defaults[appearance]
      : getMobileThemeVariables(themeId, appearance);
}

export function resolveMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  portableProfileVariables?: MobileRuntimeVariables,
): MobileRuntimeVariables {
  return portableProfileVariables ?? getMobileThemeRuntimeVariables(themeId, appearance);
}
