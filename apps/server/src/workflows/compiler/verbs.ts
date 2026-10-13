import { WorkflowStepVerb, type WorkflowDetailValue } from "@t3tools/contracts";
import type { CallExpression, Node } from "oxc-parser";

import { readAskDetail } from "./ask.ts";
import { eventTriggerProblem } from "./eventTriggers.ts";
import { detailValue, evaluateLiteral, objectProperties, readString, unwrap } from "./literals.ts";
import type { WorkflowSource } from "./source.ts";

/** The module agents may import the SDK from. The import is removed at compile time. */
export const SDK_MODULE = "@signalbox/automations";

/** Every step verb, from the contract the journal and clients share. */
const STEP_VERBS: ReadonlySet<string> = new Set<string>(WorkflowStepVerb.literals);

export const isStepVerb = (verb: string): verb is WorkflowStepVerb => STEP_VERBS.has(verb);

/** Steps whose answer is one of a known list, so code can branch on it. */
export const isOutcomeVerb = (verb: string): verb is "judge" | "ask" =>
  verb === "judge" || verb === "ask";

export const VERB_LIST = `${[...STEP_VERBS].join(", ")}, each, repeat, parallel, when, done, restart`;

const OPERATION = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_$-]+)+$/;
const SLEEP_UNITS = new Set(["seconds", "minutes", "hours", "days", "until"]);
const OUTCOMES_HINT = 'List them as string literals: ["bug", "noise"]';

export interface StepDetail {
  readonly detail: Record<string, WorkflowDetailValue>;
  readonly service?: string;
  readonly outcomes?: ReadonlyArray<string>;
  /**
   * How code branches on a step with outcomes: on its answer (`value`, the
   * default), on `answer.choice`, or not at all (`null`, e.g. a `multi` ask).
   */
  readonly decision?: "value" | "choice" | null;
}

function optionsDetail(source: WorkflowSource, node: Node | undefined) {
  const detail: Record<string, WorkflowDetailValue> = {};
  const properties = node ? objectProperties(node) : null;
  for (const [key, value] of properties ?? []) detail[key] = detailValue(source, value);
  return { detail, properties };
}

function readOutcomes(source: WorkflowSource, node: Node, what: string): string[] | null {
  const literal = evaluateLiteral(node);
  const outcomes = literal.ok && Array.isArray(literal.value) ? literal.value : null;
  if (!outcomes || !outcomes.every((outcome) => typeof outcome === "string" && outcome.trim())) {
    source.error(node, `${what} must be a literal array of non-empty strings.`, OUTCOMES_HINT);
    return null;
  }
  if (outcomes.length < 2 || new Set(outcomes).size !== outcomes.length) {
    source.error(node, `${what} needs at least two different entries.`, OUTCOMES_HINT);
    return null;
  }
  return outcomes as string[];
}

/** The host of a literal URL, or of a template URL's static start, for the step's logo. */
function urlHost(node: Node | undefined) {
  if (!node) return undefined;
  const url = unwrap(node);
  const text =
    url.type === "Literal" && typeof url.value === "string"
      ? url.value
      : url.type === "TemplateLiteral"
        ? (url.quasis[0]?.value.cooked ?? "")
        : "";
  return /^https?:\/\/([^/:?#]+)/i.exec(text)?.[1]?.toLowerCase();
}

function ensure(
  source: WorkflowSource,
  call: CallExpression,
  present: unknown,
  message: string,
  example: string,
) {
  if (present) return true;
  source.error(call, message, example);
  return false;
}

/**
 * Validates the arguments after a step's label and pulls out what the diagram
 * shows. Returns null when the call is invalid; the error is already recorded.
 * `run` is checked by the analyzer, which knows the file's functions.
 */
export function readStepDetail(
  source: WorkflowSource,
  verb: WorkflowStepVerb,
  call: CallExpression,
): StepDetail | null {
  const [, second, third, fourth] = call.arguments;
  switch (verb) {
    case "agent": {
      const { detail, properties } = optionsDetail(source, second);
      if (
        !ensure(
          source,
          call,
          properties?.has("prompt"),
          "w.agent needs an options object with a prompt.",
          'w.agent("Draft a reply", { prompt: "…" })',
        )
      )
        return null;
      const provider = readString(properties?.get("provider"));
      return { detail, ...(provider ? { service: provider } : {}) };
    }
    case "call": {
      const operation = readString(second);
      if (!operation || !OPERATION.test(operation)) {
        source.error(
          second ?? call,
          'w.call needs the operation as a string literal, like "stripe.invoices.list".',
          "The first part names the connected service; the rest is the API operation.",
        );
        return null;
      }
      const detail: Record<string, WorkflowDetailValue> = { operation: { literal: operation } };
      if (third) detail.args = detailValue(source, third);
      const connection = fourth ? objectProperties(fourth)?.get("connection") : undefined;
      if (connection) detail.connection = detailValue(source, connection);
      // `signalbox.<tool>` runs Signalbox's own tools; the rest go through Executor.
      return { detail, service: operation.slice(0, operation.indexOf(".")) };
    }
    case "http": {
      const options = second ? objectProperties(second) : null;
      const url = options ? options.get("url") : second;
      if (!url) {
        source.error(
          call,
          "w.http needs a URL.",
          'w.http("Post to Slack", { url: "https://hooks.slack.com/…", method: "POST", body })',
        );
        return null;
      }
      const detail = options
        ? optionsDetail(source, second).detail
        : { url: detailValue(source, url) };
      const host = urlHost(url);
      return { detail, ...(host ? { service: host } : {}) };
    }
    case "run":
      return { detail: {} };
    case "llm":
    case "extract": {
      const { detail, properties } = optionsDetail(source, second);
      const needed = verb === "llm" ? "prompt" : "input";
      const example =
        verb === "llm"
          ? 'w.llm("Summarize", { prompt })'
          : 'w.extract("Read the invoice", { input: text, schema: { total: "number" } })';
      if (
        !ensure(
          source,
          call,
          properties?.has(needed),
          `w.${verb} needs an options object with ${needed}.`,
          example,
        )
      )
        return null;
      return { detail };
    }
    case "judge": {
      const { detail, properties } = optionsDetail(source, second);
      const outcomesNode = properties?.get("outcomes");
      if (!outcomesNode) {
        source.error(
          call,
          "w.judge needs outcomes.",
          'w.judge("Real bug or noise?", { input: issue, outcomes: ["bug", "noise"] })',
        );
        return null;
      }
      const outcomes = readOutcomes(source, outcomesNode, "Judge outcomes");
      if (!outcomes) return null;
      delete detail.outcomes;
      return { detail, outcomes };
    }
    case "ask":
      return readAskDetail(source, second);
    case "notify":
      if (!second) {
        source.error(
          call,
          "w.notify needs a message after its label.",
          'w.notify("Report sent", `Sent ${count} reminders`)',
        );
        return null;
      }
      return {
        detail: { message: detailValue(source, second), ...optionsDetail(source, third).detail },
      };
    case "sleep": {
      const { detail, properties } = optionsDetail(source, second);
      const valid = properties && [...properties.keys()].some((key) => SLEEP_UNITS.has(key));
      if (
        !ensure(
          source,
          call,
          valid,
          "w.sleep needs a duration or an until time.",
          'w.sleep("Give them a day", { days: 1 }) or { until: isoDateString }',
        )
      )
        return null;
      return { detail };
    }
    case "waitFor": {
      const { detail, properties } = optionsDetail(source, second);
      const example =
        'w.waitFor("Wait for checks", { on: ["pr.checks.passed", "pr.checks.failed"], where: { number }, timeout: { minutes: 30 } })';
      const on = properties?.get("on");
      if (
        !ensure(
          source,
          call,
          properties?.has("event") || on,
          "w.waitFor needs the event to wait for: `on` for Signalbox events, `event` for automation_emit names.",
          example,
        )
      )
        return null;
      if (on) {
        // Literal, so the engine knows from the diagram which events to keep for the run.
        const literal = evaluateLiteral(on);
        if (!literal.ok) {
          source.error(
            on,
            "`on` must be a literal event name or list, so the run can collect matching events from its start.",
            example,
          );
          return null;
        }
        const problem = eventTriggerProblem([{ on: literal.value }]);
        if (problem) {
          source.error(
            on,
            problem.message.replace("meta.triggers listens for", "w.waitFor waits for"),
            problem.hint,
          );
          return null;
        }
      }
      return { detail };
    }
    case "recall":
    case "remember": {
      const example =
        verb === "recall"
          ? 'w.recall("Last handled issue", "cursor")'
          : 'w.remember("Save the cursor", "cursor", lastId)';
      if (!second) {
        source.error(call, `w.${verb} needs a key after its label.`, example);
        return null;
      }
      const value = verb === "remember" && third ? { value: detailValue(source, third) } : {};
      return { detail: { key: detailValue(source, second), ...value } };
    }
    case "start":
      if (!second || readString(second) === null) {
        source.error(
          call,
          "w.start needs the automation's name as a string.",
          'w.start("Kick off the weekly report", "Weekly report", { week })',
        );
        return null;
      }
      return {
        detail: {
          automation: detailValue(source, second),
          ...(third ? { input: detailValue(source, third) } : {}),
        },
      };
  }
}

/** Reads a positive integer option such as `max` or `concurrency`; null when absent. */
export function readPositiveInt(
  source: WorkflowSource,
  node: Node | undefined,
  name: string,
  limit: number,
): number | null | "invalid" {
  if (!node) return null;
  const literal = evaluateLiteral(unwrap(node));
  const value = literal.ok ? literal.value : null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > limit) {
    source.error(node, `${name} must be a literal whole number from 1 to ${limit}.`);
    return "invalid";
  }
  return value;
}
