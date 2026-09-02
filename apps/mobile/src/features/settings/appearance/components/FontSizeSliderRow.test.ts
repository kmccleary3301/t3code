import { describe, expect, it } from "vite-plus/test";

import {
  fontSizeSliderAccessibilityState,
  resolveFontSizeSliderAccessibilityAction,
} from "./fontSizeSliderAccessibility";

describe("FontSizeSliderRow accessibility", () => {
  it("exposes the disabled state to assistive technology", () => {
    expect(fontSizeSliderAccessibilityState(true)).toEqual({ disabled: true });
    expect(fontSizeSliderAccessibilityState(false)).toEqual({ disabled: false });
  });

  it("does not mutate when an adjustable action arrives while disabled", () => {
    expect(resolveFontSizeSliderAccessibilityAction("increment", true, 12, 24, 1, 16)).toBeNull();
    expect(resolveFontSizeSliderAccessibilityAction("decrement", true, 12, 24, 1, 16)).toBeNull();
  });

  it("clamps enabled adjustable actions to the slider bounds", () => {
    expect(resolveFontSizeSliderAccessibilityAction("increment", false, 12, 16, 1, 16)).toBe(16);
    expect(resolveFontSizeSliderAccessibilityAction("decrement", false, 12, 16, 1, 12)).toBe(12);
  });
});
