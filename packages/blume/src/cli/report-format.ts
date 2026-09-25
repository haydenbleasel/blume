/**
 * Number formatting shared by the translate and eval report renderers. The
 * `1.5s` / `4m 12s` shapes are asserted in both suites — change them in both
 * minds at once.
 */

/** Milliseconds as `1.5s`. */
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** A dollar cost as `$1.23`, or nothing when the run reported none. */
export const money = (cost: number | undefined): string =>
  cost === undefined ? "" : `$${cost.toFixed(2)}`;

/**
 * Milliseconds as `12.3s` under a minute, `4m 12s` from there up. Rounding
 * happens before the split, so a value just under a boundary carries over
 * (`59_990` → `1m 0s`, `119_700` → `2m 0s`) instead of printing `60.0s` or
 * `1m 60s`.
 */
export const duration = (ms: number): string => {
  const tenths = Math.round(ms / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)}s`;
  }
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
};
