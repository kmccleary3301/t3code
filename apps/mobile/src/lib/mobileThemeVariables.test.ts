import { describe, expect, it } from "vite-plus/test";

import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";
import { getMobileThemeVariables } from "./mobileTheme";
import {
  getMobileThemeRuntimeVariables,
  resolveMobileThemeRuntimeVariables,
} from "./mobileThemeVariables";

describe("mobile theme runtime variables", () => {
  it("derives the standard runtime palette from global.css", () => {
    expect(getMobileThemeRuntimeVariables("t3-code", "light")).toEqual(
      readDefaultMobileThemeVariables("light"),
    );
    expect(getMobileThemeRuntimeVariables("t3-code", "dark")).toEqual(
      readDefaultMobileThemeVariables("dark"),
    );
  });

  it("uses the same shared palette source as generated custom themes", () => {
    expect(getMobileThemeRuntimeVariables("ocean", "light")).toEqual(
      getMobileThemeVariables("ocean", "light"),
    );
    expect(getMobileThemeRuntimeVariables("iris", "dark")).toEqual(
      getMobileThemeVariables("iris", "dark"),
    );
  });

  it("does not replace a selected built-in palette when no portable profile is active", () => {
    const selected = getMobileThemeRuntimeVariables("grove", "dark");
    const portable = getMobileThemeRuntimeVariables("t3-chat", "dark");

    expect(resolveMobileThemeRuntimeVariables("grove", "dark")).toEqual(selected);
    expect(resolveMobileThemeRuntimeVariables("grove", "dark")).not.toEqual(portable);
    expect(resolveMobileThemeRuntimeVariables("grove", "dark", portable)).toEqual(portable);
  });
});
