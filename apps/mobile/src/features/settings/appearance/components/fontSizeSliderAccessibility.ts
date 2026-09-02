export function resolveFontSizeSliderAccessibilityAction(
  actionName: string,
  disabled: boolean | undefined,
  min: number,
  max: number,
  step: number,
  value: number,
): number | null {
  if (disabled) return null;
  if (actionName === "increment") return Math.min(max, value + step);
  if (actionName === "decrement") return Math.max(min, value - step);
  return null;
}

export function fontSizeSliderAccessibilityState(disabled: boolean | undefined): {
  readonly disabled: boolean;
} {
  return { disabled: Boolean(disabled) };
}
