import {
  askFieldProblems,
  AUTOMATION_ASK_DEFAULT_OPTIONS,
  AUTOMATION_ASK_SUBMIT,
  type WorkflowDetailValue,
} from "@t3tools/contracts";
import type { Node } from "oxc-parser";

import { detailValue, evaluateLiteral, objectProperties, readString, unwrap } from "./literals.ts";
import type { WorkflowSource } from "./source.ts";
import type { StepDetail } from "./verbs.ts";

const OPTIONS_HINT = 'List them as strings, e.g. options: ["send", "skip"]';
const FIELDS_HINT = 'e.g. fields: { reply: { type: "longText", default: draft } }';

/** Whether an object literal has spreads or computed keys, so its shape isn't known here. */
function hasDynamicKeys(node: Node) {
  const object = unwrap(node);
  return (
    object.type === "ObjectExpression" &&
    object.properties.some((property) => property.type !== "Property" || property.computed)
  );
}

/**
 * Checks literal field specs with the engine's own rules. Computed parts are
 * left to the engine, which fails the step if they turn out wrong.
 */
function checkFields(source: WorkflowSource, node: Node): boolean {
  const fields = objectProperties(node);
  if (!fields || hasDynamicKeys(node)) return true;
  let ok = true;
  for (const [name, fieldNode] of fields) {
    const props = objectProperties(fieldNode);
    let problems: string[];
    if (props) {
      if (hasDynamicKeys(fieldNode)) continue;
      const spec: Record<string, unknown> = {};
      const unknownKeys = new Set<string>();
      for (const [key, value] of props) {
        const literal = evaluateLiteral(value);
        spec[key] = literal.ok ? literal.value : null;
        if (!literal.ok) unknownKeys.add(key);
      }
      problems = askFieldProblems(name, spec, unknownKeys);
    } else {
      const literal = evaluateLiteral(fieldNode);
      if (!literal.ok) continue;
      problems = askFieldProblems(name, literal.value);
    }
    for (const problem of problems) source.error(fieldNode, problem, FIELDS_HINT);
    if (problems.length > 0) ok = false;
  }
  return ok;
}

/**
 * `w.ask(label, { question?, options?, multi?, fields?, timeout?, onTimeout? })`.
 * Literal options become the step's outcomes, so code can branch on them:
 * on the answer itself, or on `answer.choice` when the ask has fields.
 * Computed options draw as one "one of …" outcome; `multi` answers are lists,
 * so neither decides a branch.
 */
export function readAskDetail(source: WorkflowSource, node: Node | undefined): StepDetail | null {
  const detail: Record<string, WorkflowDetailValue> = {};
  const properties = node ? objectProperties(node) : null;
  for (const [key, value] of properties ?? []) detail[key] = detailValue(source, value);

  const multiNode = properties?.get("multi");
  const multiLiteral = multiNode ? evaluateLiteral(multiNode) : null;
  if (multiLiteral && !(multiLiteral.ok && typeof multiLiteral.value === "boolean")) {
    source.error(multiNode!, "multi must be true or false.");
    return null;
  }
  const multi = multiLiteral?.ok === true && multiLiteral.value === true;

  const fieldsNode = properties?.get("fields");
  if (fieldsNode && !checkFields(source, fieldsNode)) return null;

  const optionsNode = properties?.get("options");
  delete detail.options;
  let outcomes: string[];
  let dynamic = false;
  if (optionsNode) {
    const literal = evaluateLiteral(optionsNode);
    if (literal.ok) {
      const values = Array.isArray(literal.value) ? literal.value : null;
      if (!values || !values.every((value) => typeof value === "string" && value.trim())) {
        source.error(optionsNode, "Ask options must be a list of non-empty strings.", OPTIONS_HINT);
        return null;
      }
      const least = fieldsNode ? 1 : 2;
      if (values.length < least || new Set(values).size !== values.length) {
        source.error(
          optionsNode,
          least === 1
            ? "Ask options need at least one entry, each different."
            : "Ask options need at least two different entries.",
          OPTIONS_HINT,
        );
        return null;
      }
      outcomes = values as string[];
    } else {
      const shown = detailValue(source, optionsNode);
      outcomes = [`one of ${"expression" in shown ? shown.expression : "…"}`];
      dynamic = true;
    }
  } else if (multi) {
    source.error(multiNode!, "multi needs options to pick from.", OPTIONS_HINT);
    return null;
  } else {
    outcomes = fieldsNode ? [AUTOMATION_ASK_SUBMIT] : [...AUTOMATION_ASK_DEFAULT_OPTIONS];
  }

  const onTimeout = properties?.get("onTimeout");
  if (onTimeout) {
    const fallback = readString(onTimeout);
    if (fallback === null || (fallback !== "fail" && !dynamic && !outcomes.includes(fallback))) {
      source.error(
        onTimeout,
        dynamic
          ? 'onTimeout must be "fail" or one of the options, as a string.'
          : `onTimeout must be "fail" or one of the options: ${outcomes.join(", ")}.`,
        'w.ask("Ship it?", { options: ["ship", "hold"], timeout: { days: 3 }, onTimeout: "hold" })',
      );
      return null;
    }
  }
  return {
    detail,
    outcomes,
    decision: dynamic || multi ? null : fieldsNode ? "choice" : "value",
  };
}
