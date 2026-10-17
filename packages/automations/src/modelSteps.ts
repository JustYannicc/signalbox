import type { WorkflowStepVerb } from "@t3tools/contracts";

import { toJson } from "./json.ts";
import { jsonModelOutput, judgeVerdict } from "./modelOutput.ts";

/**
 * Model steps use supplied text only. Hosts with a model gateway call it
 * directly; self-hosted servers retain their plan-mode thread adapter.
 */

const MODEL_VERBS = new Set(["llm", "judge", "extract"] as const);
export type ModelVerb = typeof MODEL_VERBS extends Set<infer V> ? V : never;

/** The verbs that ask a model to interpret supplied text. */
export const isModelVerb = (verb: WorkflowStepVerb): verb is ModelVerb =>
  MODEL_VERBS.has(verb as ModelVerb);

type Options = Readonly<Record<string, unknown>>;
type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const NO_TOOLS = "Answer from the information given here. Don't use tools or change any files.";

function block(value: unknown) {
  return typeof value === "string" ? value : toJson(value ?? null);
}

function outcomesOf(options: Options): string[] {
  return Array.isArray(options.outcomes)
    ? options.outcomes.filter((value): value is string => typeof value === "string")
    : [];
}

export function modelPrompt(verb: ModelVerb, label: string, options: Options): string {
  const input = options.input === undefined ? "" : `\n\nInput:\n${block(options.input)}`;
  switch (verb) {
    case "judge":
      return [
        `${typeof options.question === "string" ? options.question : label}${input}`,
        options.outcomes === undefined
          ? 'Reply with only JSON: { "verdict": true or false, "reason": "why" }.'
          : `Answer with exactly one of: ${outcomesOf(options).join(", ")}. Reply with only that word.`,
        NO_TOOLS,
      ].join("\n\n");
    case "extract":
      return [
        `Extract the following from the input as JSON.\n\nShape:\n${block(options.schema ?? "whatever fits")}${input}`,
        "Reply with only the JSON, no prose and no code fences.",
        NO_TOOLS,
      ].join("\n\n");
    default:
      return `${block(options.prompt)}${input}\n\n${NO_TOOLS}`;
  }
}

const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^[`"'*\s]+|[`"'*.!\s]+$/g, "");

/** Reads a model step's final message as the value the code gets back. */
export function modelResult(verb: ModelVerb, options: Options, text: string): Outcome {
  if (verb === "judge") {
    if (options.outcomes === undefined) return judgeVerdict(text);
    const outcomes = outcomesOf(options);
    const answer = normalize(text);
    const exact = outcomes.find((outcome) => outcome.toLowerCase() === answer);
    if (exact) return { ok: true, value: exact };
    const mentioned = outcomes.filter((outcome) =>
      new RegExp(`\\b${outcome.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        answer,
      ),
    );
    return mentioned.length === 1
      ? { ok: true, value: mentioned[0] }
      : {
          ok: false,
          error: `The model answered "${text.trim().slice(0, 200)}", not one of: ${outcomes.join(", ")}.`,
        };
  }
  if (verb === "extract") {
    return jsonModelOutput(text, options.schema);
  }
  return { ok: true, value: text.trim() };
}
