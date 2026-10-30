import type { AskKitQuestion } from "@t3tools/shared/askKit";
import { decodeAskKitAnswer } from "@t3tools/shared/askKitAnswer";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSliderValue,
  sliderPositionOf,
  sliderStepCount,
  sliderValueAt,
} from "@t3tools/client-runtime/askSlider";

type Grid = { readonly min: number; readonly max: number; readonly step: number };

/** Every grid point the helper produces, checked by the contract's own slider answer rules. */
function grid(props: Grid) {
  const question: AskKitQuestion = {
    options: [],
    surface: { kind: "kit", component: "slider", props },
  };
  const values = Array.from({ length: sliderStepCount(props) + 1 }, (_, position) =>
    sliderValueAt(props, position),
  );
  for (const value of values) {
    expect(Result.isSuccess(decodeAskKitAnswer(question, { value })), String(value)).toBe(true);
  }
  return values;
}

describe("ask slider numbers", () => {
  it("keeps an offset start that a whole step would round away", () => {
    const offset = { min: 0.5, max: 2.5, step: 1 };
    expect(grid(offset)).toEqual([0.5, 1.5, 2.5]);
    expect(formatSliderValue(offset, 0.5, "en-US")).toBe("0.5");
    expect(sliderPositionOf(offset, 1.5)).toBe(1);
  });

  it("sends decimal steps without float noise", () => {
    const tenths = { min: 0, max: 1, step: 0.1 };
    expect(sliderValueAt(tenths, 3)).toBe(0.3);
    expect(grid(tenths)).toHaveLength(11);
    expect(formatSliderValue(tenths, 0.3, "en-US")).toBe("0.3");
  });

  it("finds grid points far from zero, where step counts drift", () => {
    const far = { min: 999_999_999_999, max: 1e12, step: 0.1 };
    const values = grid(far);
    expect(values[1]).toBe(999_999_999_999.1);
    expect(values.at(-1)).toBe(1e12);
    expect(sliderPositionOf(far, 999_999_999_999.1)).toBe(1);
    expect(formatSliderValue(far, 999_999_999_999.1, "en-US")).toBe("999,999,999,999.1");
  });

  it("reads precision from steps written in exponent notation", () => {
    const tiny = { min: 0, max: 1e-6, step: 1e-7 };
    expect(grid(tiny)[3]).toBe(3e-7);
    expect(formatSliderValue(tiny, 3e-7, "en-US")).toBe("0.0000003");
    // 1.5e-7 has eight decimals, not the one its mantissa shows.
    const odd = { min: 0, max: 1.5e-6, step: 1.5e-7 };
    expect(grid(odd)[3]).toBe(4.5e-7);
    expect(formatSliderValue(odd, 4.5e-7, "en-US")).toBe("0.00000045");
    // A large step in exponent notation has no decimals at all.
    expect(formatSliderValue({ min: 0, max: 1e4, step: 2.5e3 }, 5e3, "en-US")).toBe("5,000");
  });

  it("writes grids past Intl's portable precision in the number's own form", () => {
    const fine = { min: 0, max: 1e-24, step: 1e-25 };
    expect(grid(fine)[3]).toBe(3e-25);
    expect(formatSliderValue(fine, 3e-25, "en-US")).toBe("3e-25");
  });

  it("handles negative ranges, units and out-of-range positions", () => {
    const signed = { min: -1, max: 1, step: 0.25, unit: "pts" };
    expect(grid(signed)[1]).toBe(-0.75);
    expect(formatSliderValue(signed, -0.75, "en-US")).toBe("-0.75 pts");
    expect(sliderValueAt(signed, -4)).toBe(-1);
    expect(sliderValueAt(signed, 99)).toBe(1);
    expect(sliderPositionOf(signed, 7)).toBe(8);
    expect(formatSliderValue({ min: 0, max: 5_000, step: 500 }, 2_500, "en-US")).toBe("2,500");
  });
});
