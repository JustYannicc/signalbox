/**
 * The numbers an ask kit slider (#669) shows and sends, shared so web and mobile land on the
 * same grid. The contract has already checked that `step` divides `max - min` into whole steps;
 * these helpers only pick grid points and write them the way the agent wrote the grid.
 */
import type { AskKitSliderProps } from "@t3tools/contracts/askKit";

type SliderGrid = Pick<AskKitSliderProps, "min" | "max" | "step">;

/** Decimal places as JavaScript writes the number, exponent included: 1.5e-7 is 8, 2.5e3 is 0. */
function decimalPlaces(value: number): number {
  const written = /^-?\d+(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(String(value));
  if (written === null) return 0;
  return Math.max(0, (written[1]?.length ?? 0) - Number(written[2] ?? 0));
}

/** Every exact grid point `min + k * step` needs at most this many decimals. */
const gridPrecision = (grid: SliderGrid) =>
  Math.max(decimalPlaces(grid.min), decimalPlaces(grid.step));

export function sliderStepCount(grid: SliderGrid): number {
  return Math.round((grid.max - grid.min) / grid.step);
}

/** The nearest grid position to `value`, clamped to the slider. */
export function sliderPositionOf(grid: SliderGrid, value: number): number {
  const position = Math.round((value - grid.min) / grid.step);
  return Math.max(0, Math.min(sliderStepCount(grid), position));
}

/**
 * The grid point `position` steps from `min`, clamped. Float noise is rounded off at the grid's
 * precision, so 0.1 * 3 sends 0.3 and an offset like 0.5 survives a whole step. Where `toFixed`
 * can't write the number (over 100 decimals, or 1e21 and up) it's sent as computed.
 */
export function sliderValueAt(grid: SliderGrid, position: number): number {
  const count = sliderStepCount(grid);
  const clamped = Math.max(0, Math.min(count, Math.round(position)));
  if (clamped === count) return grid.max;
  const value = grid.min + clamped * grid.step;
  const digits = gridPrecision(grid);
  return digits <= 100 && Math.abs(value) < 1e21 ? Number(value.toFixed(digits)) : value;
}

/**
 * A grid value written to the grid's precision, with the unit. Past 20 decimals, which not
 * every `Intl` implementation formats, it falls back to the number's own shortest form.
 */
export function formatSliderValue(
  grid: SliderGrid & { readonly unit?: string | undefined },
  value: number,
  locales?: Intl.LocalesArgument,
): string {
  const digits = gridPrecision(grid);
  const number =
    digits <= 20
      ? value.toLocaleString(locales, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      : String(value);
  return grid.unit ? `${number} ${grid.unit}` : number;
}
