/**
 * Reads a question's answer kit surface the same way on the server and every client: which
 * component renders and what's wrong with what an agent raised. `askKitAnswer` reads answers.
 */
import {
  ASK_KIT_SLIDER_MAX_STEPS,
  ASK_KIT_TEXT_MAX_LENGTH,
  AskKitChoicesProps,
  AskKitComponent,
  AskKitCompareProps,
  AskKitRankingProps,
  AskKitSliderProps,
  AskKitTextProps,
  type AskKitFont,
  type AskKitOptionStyle,
  type AskKitProblem,
} from "@t3tools/contracts/askKit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

import { canonicalJson, jsonProblem, kitOptionIndex, problem, type Path } from "./askKit/json.ts";
import type {
  AskKitComponentSpec,
  AskKitOptionLooks,
  AskKitQuestion,
  AskKitResolution,
} from "./askKit/types.ts";
import { decodeKitValue, sliderStepCount } from "./askKit/values.ts";

export type {
  AskKitComponentSpec,
  AskKitOptionLooks,
  AskKitQuestion,
  AskKitResolution,
  AskKitSpec,
} from "./askKit/types.ts";

const PROPS_PATH = ["surface", "props"] as const;

// Excess properties are errors, so a misspelled prop is reported instead of silently dropped.
const exact = { onExcessProperty: "error" } as const;
const decodeComponentProps = {
  choices: Schema.decodeUnknownResult(AskKitChoicesProps, exact),
  ranking: Schema.decodeUnknownResult(AskKitRankingProps, exact),
  compare: Schema.decodeUnknownResult(AskKitCompareProps, exact),
  slider: Schema.decodeUnknownResult(AskKitSliderProps, exact),
  text: Schema.decodeUnknownResult(AskKitTextProps, exact),
};
const isAskKitComponent = Schema.is(AskKitComponent);

function firstIssue(issue: SchemaIssue.Issue, path: Path): { path: Path; message: string } {
  switch (issue._tag) {
    case "Pointer":
      return firstIssue(issue.issue, [
        ...path,
        ...issue.path.map((key) => (typeof key === "number" ? key : String(key))),
      ]);
    case "Filter":
    case "Encoding":
      return firstIssue(issue.issue, path);
    case "Composite":
      return firstIssue(issue.issues[0], path);
    case "AnyOf":
      return issue.issues[0] === undefined
        ? { path, message: "Invalid value." }
        : firstIssue(issue.issues[0], path);
    case "MissingKey":
      return { path, message: "Missing property." };
    case "UnexpectedKey":
      return { path, message: "Unknown property." };
    case "InvalidType":
      return { path, message: "Invalid type." };
    default:
      return { path, message: "Invalid value." };
  }
}

function decodeProps<A>(
  decoded: Result.Result<A, Schema.SchemaError>,
  problems: AskKitProblem[],
): A | null {
  if (Result.isSuccess(decoded)) return decoded.success;
  const issue = firstIssue(decoded.failure.issue, PROPS_PATH);
  problems.push(problem("props-invalid", issue.path, issue.message));
  return null;
}

function optionLooks(
  styles: ReadonlyArray<AskKitOptionStyle> | undefined,
  optionCount: number,
  problems: AskKitProblem[],
): AskKitOptionLooks {
  const looks: Array<Omit<AskKitOptionStyle, "option"> | null> = Array.from(
    { length: optionCount },
    () => null,
  );
  (styles ?? []).forEach(({ option, ...look }, index) => {
    const path = [...PROPS_PATH, "optionStyles", index, "option"];
    if (option >= optionCount) {
      problems.push(problem("option-out-of-range", path, "No option has this index."));
    } else if (looks[option] !== null) {
      problems.push(problem("option-repeated", path, "This option is styled twice."));
    } else looks[option] = look;
  });
  return looks;
}

const MINIMUM_OPTIONS = { choices: 1, compare: 2, ranking: 2, slider: 0, text: 0 } as const;

function componentSpec(
  component: AskKitComponent,
  props: unknown,
  question: AskKitQuestion,
  problems: AskKitProblem[],
): AskKitComponentSpec | null {
  const count = question.options.length;
  const minimum = MINIMUM_OPTIONS[component];
  if (count < minimum) {
    problems.push(
      problem("options-missing", ["options"], `${component} needs ${minimum}+ options.`),
    );
  }
  if ((component === "slider" || component === "text") && count > 0) {
    problems.push(problem("options-unexpected", ["options"], `${component} doesn't use options.`));
  }
  if (component !== "choices" && question.multiSelect === true) {
    problems.push(
      problem("multi-select-unsupported", ["multiSelect"], `${component} answers with one value.`),
    );
  }
  switch (component) {
    case "choices":
    case "ranking": {
      const decoded = decodeProps(decodeComponentProps[component](props), problems);
      if (decoded === null) return null;
      const looks = optionLooks(decoded.optionStyles, count, problems);
      return component === "choices"
        ? { component, multiSelect: question.multiSelect === true, looks }
        : { component, looks };
    }
    case "compare": {
      const decoded = decodeProps(decodeComponentProps.compare(props), problems);
      if (decoded === null) return null;
      const covered = new Set<number>();
      decoded.panes.forEach(({ option }, index) => {
        const path = [...PROPS_PATH, "panes", index, "option"];
        if (option >= count) {
          problems.push(problem("option-out-of-range", path, "No option has this index."));
        } else if (covered.has(option)) {
          problems.push(problem("option-repeated", path, "Two panes show this option."));
        }
        covered.add(option);
      });
      for (let option = 0; option < count; option++) {
        if (!covered.has(option)) {
          problems.push(problem("pane-missing", ["options", option], "This option has no pane."));
        }
      }
      const looks = optionLooks(decoded.optionStyles, count, problems);
      return { component, panes: decoded.panes, looks };
    }
    case "slider": {
      const decoded = decodeProps(decodeComponentProps.slider(props), problems);
      if (decoded === null) return null;
      if (decoded.min >= decoded.max) {
        problems.push(
          problem("slider-range-invalid", [...PROPS_PATH, "max"], "max must be above min."),
        );
      } else if (sliderStepCount(decoded) === null) {
        problems.push(
          problem(
            "slider-step-invalid",
            [...PROPS_PATH, "step"],
            `step must divide the range into at most ${ASK_KIT_SLIDER_MAX_STEPS} steps.`,
          ),
        );
      }
      return { component, ...decoded };
    }
    case "text": {
      const decoded = decodeProps(decodeComponentProps.text(props), problems);
      if (decoded === null) return null;
      return { component, ...decoded, maxLength: decoded.maxLength ?? ASK_KIT_TEXT_MAX_LENGTH };
    }
  }
}

/**
 * Surfaces the kit doesn't own resolve to `legacy` with no problems: the kit adds no rules to
 * provider questions, automation forms or custom HTML beyond the ask contract's own.
 */
export function resolveAskKit(question: AskKitQuestion): AskKitResolution {
  const { surface } = question;
  if (surface.kind === "html" || !isAskKitComponent(surface.component)) {
    const reason = surface.kind === "html" ? "html" : "unknown-component";
    return {
      spec: { component: "legacy", reason, multiSelect: question.multiSelect === true },
      problems: [],
    };
  }

  const problems: AskKitProblem[] = [];
  const invalid: AskKitResolution = { spec: { component: "invalid" }, problems };
  const options = kitOptionIndex(question.options, problems);
  const props = surface.props ?? {};
  const json = canonicalJson(props);
  if ("failure" in json) {
    problems.push(jsonProblem(json.failure, PROPS_PATH));
    return invalid;
  }
  const spec = componentSpec(surface.component, props, question, problems);
  if (spec === null || problems.length > 0) return invalid;

  if (question.recommendation !== undefined && question.recommendation !== null) {
    const recommendation = decodeKitValue(spec, options, question.recommendation);
    if (Result.isFailure(recommendation)) {
      const { message } = recommendation.failure;
      problems.push(problem("recommendation-invalid", ["recommendation"], message));
    }
  }
  return { spec, problems };
}

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
]);

/** A CSS `font-family` value that falls back to the system font when the device lacks it. */
export function askKitFontFamily(font: AskKitFont): string {
  return GENERIC_FONTS.has(font) ? font : `"${font}", system-ui, sans-serif`;
}
