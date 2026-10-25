/**
 * Reads and builds the structured part of an answer for a question's kit surface (see `askKit`).
 * The comment is never checked here beyond being present on a words-only answer.
 */
import type { AskKitProblem } from "@t3tools/contracts/askKit";
import * as Result from "effect/Result";

import { resolveAskKit } from "./askKit.ts";
import { isJsonValue, kitOptionIndex, problem } from "./askKit/json.ts";
import type { AskKitQuestion, AskKitValue } from "./askKit/types.ts";
import { decodeKitValue } from "./askKit/values.ts";

export type { AskKitValue } from "./askKit/types.ts";

/**
 * Checks an answer against what the question renders. A legacy surface takes any JSON, `null`
 * included. A kit component takes its own value, or `null` with a comment for words only; a kit
 * component raised with invalid props takes words only.
 */
export function decodeAskKitAnswer(
  question: AskKitQuestion,
  answer: { readonly value: unknown; readonly comment?: string | undefined },
): Result.Result<AskKitValue, AskKitProblem> {
  const { spec } = resolveAskKit(question);
  if (spec.component === "legacy") {
    return isJsonValue(answer.value)
      ? Result.succeed({ component: "legacy", value: answer.value })
      : Result.fail(problem("json-invalid", ["value"], "Not a JSON value."));
  }
  if (answer.value === null) {
    return (answer.comment ?? "").trim().length > 0
      ? Result.succeed({ component: "words-only" })
      : Result.fail(problem("answer-empty", ["comment"], "A words-only answer needs a comment."));
  }
  if (spec.component === "invalid") {
    return Result.fail(problem("answer-invalid", ["value"], "This question takes words only."));
  }
  return decodeKitValue(spec, kitOptionIndex(question.options, []), answer.value);
}

/** The answer value a client sends; the inverse of `decodeAskKitAnswer` for a valid value. */
export function encodeAskKitAnswer(question: AskKitQuestion, value: AskKitValue): unknown {
  const optionValue = (position: number) => question.options[position]?.value;
  switch (value.component) {
    case "choices":
      return question.multiSelect === true
        ? value.selected.map(optionValue)
        : optionValue(value.selected[0] ?? -1);
    case "compare":
      return optionValue(value.selected);
    case "ranking":
      return value.order.map(optionValue);
    case "slider":
      return value.value;
    case "text":
      return value.text;
    case "words-only":
      return null;
    case "legacy":
      return value.value;
  }
}
