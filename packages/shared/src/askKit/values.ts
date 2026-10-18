import {
  ASK_KIT_SLIDER_MAX_STEPS,
  type AskKitProblem,
  type AskKitSliderProps,
} from "@t3tools/contracts/askKit";
import * as Result from "effect/Result";

import { canonicalJson, jsonProblem, problem, type Path } from "./json.ts";
import type { AskKitComponentSpec, AskKitValue } from "./types.ts";

type SliderGrid = Pick<AskKitSliderProps, "min" | "max" | "step">;

/**
 * Rounding error a grid point may carry at these magnitudes: subtracting, scaling and adding
 * back each lose at most an ulp of the largest number involved. Comparing by step counts alone
 * fails far from zero, where `(value - min) / step` drifts by whole fractions of a step.
 */
const gridTolerance = ({ min, max, step }: SliderGrid) =>
  8 * Number.EPSILON * Math.max(Math.abs(min), Math.abs(max), Math.abs(step));

/**
 * Steps from `min` to `max`, or null when the step doesn't divide the range into 1 to
 * `ASK_KIT_SLIDER_MAX_STEPS` steps. A step within a few tolerances of zero is refused too:
 * the grid points would sit closer than rounding error and off-grid numbers would pass.
 */
export function sliderStepCount(grid: SliderGrid): number | null {
  const tolerance = gridTolerance(grid);
  if (grid.step < 4 * tolerance) return null;
  const count = Math.round((grid.max - grid.min) / grid.step);
  if (count < 1 || count > ASK_KIT_SLIDER_MAX_STEPS) return null;
  return Math.abs(grid.min + count * grid.step - grid.max) <= tolerance ? count : null;
}

/** Whether `value` is one of the grid's points, rebuilt as `min + k * step` and compared. */
function onSliderGrid(grid: SliderGrid, value: number): boolean {
  const count = sliderStepCount(grid);
  const position = Math.round((value - grid.min) / grid.step);
  if (count === null || position < 0 || position > count) return false;
  return Math.abs(grid.min + position * grid.step - value) <= gridTolerance(grid);
}

/** A structured value against a kit component; `options` maps canonical option JSON to index. */
export function decodeKitValue(
  spec: AskKitComponentSpec,
  options: ReadonlyMap<string, number>,
  value: unknown,
): Result.Result<AskKitValue, AskKitProblem> {
  const path = ["value"];
  const json = canonicalJson(value);
  if ("failure" in json) return Result.fail(jsonProblem(json.failure, path));

  const optionAt = (item: unknown, itemPath: Path): Result.Result<number, AskKitProblem> => {
    const key = canonicalJson(item);
    const position = "key" in key ? options.get(key.key) : undefined;
    return position === undefined
      ? Result.fail(
          problem("answer-unknown-option", itemPath, "Not one of the question's options."),
        )
      : Result.succeed(position);
  };
  const optionList = (list: unknown): Result.Result<ReadonlyArray<number>, AskKitProblem> => {
    if (!Array.isArray(list)) {
      return Result.fail(problem("answer-invalid", path, "Expected a list of options."));
    }
    const positions: number[] = [];
    for (const [item, entry] of list.entries()) {
      const position = optionAt(entry, [...path, item]);
      if (Result.isFailure(position)) return Result.fail(position.failure);
      if (positions.includes(position.success)) {
        return Result.fail(
          problem("answer-repeated", [...path, item], "This option is listed twice."),
        );
      }
      positions.push(position.success);
    }
    return Result.succeed(positions);
  };

  switch (spec.component) {
    case "choices": {
      if (!spec.multiSelect) {
        return Result.map(optionAt(value, path), (position) => ({
          component: "choices" as const,
          selected: [position],
        }));
      }
      const selected = optionList(value);
      if (Result.isSuccess(selected) && selected.success.length === 0) {
        return Result.fail(
          problem("answer-empty", path, "Pick at least one option, or answer in words only."),
        );
      }
      return Result.map(selected, (positions) => ({
        component: "choices" as const,
        selected: [...positions].sort((a, b) => a - b),
      }));
    }
    case "compare":
      return Result.map(optionAt(value, path), (selected) => ({
        component: "compare" as const,
        selected,
      }));
    case "ranking": {
      const order = optionList(value);
      if (Result.isSuccess(order) && order.success.length !== options.size) {
        return Result.fail(
          problem("answer-incomplete", path, "A ranking places every option once."),
        );
      }
      return Result.map(order, (positions) => ({
        component: "ranking" as const,
        order: positions,
      }));
    }
    case "slider": {
      if (typeof value !== "number") {
        return Result.fail(problem("answer-invalid", path, "Expected a number."));
      }
      if (value < spec.min || value > spec.max) {
        return Result.fail(
          problem("answer-out-of-range", path, "The number is outside the slider's range."),
        );
      }
      if (!onSliderGrid(spec, value)) {
        return Result.fail(
          problem("answer-off-step", path, "The number isn't on one of the slider's steps."),
        );
      }
      return Result.succeed({ component: "slider", value });
    }
    case "text": {
      if (typeof value !== "string") {
        return Result.fail(problem("answer-invalid", path, "Expected text."));
      }
      if (value.trim().length === 0) {
        return Result.fail(problem("answer-empty", path, "The answer is blank."));
      }
      if (value.length > spec.maxLength) {
        return Result.fail(
          problem("answer-too-long", path, `The answer is over ${spec.maxLength} characters.`),
        );
      }
      return Result.succeed({ component: "text", text: value });
    }
  }
}
