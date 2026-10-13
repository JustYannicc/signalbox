import { WorkflowMeta } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { Node } from "oxc-parser";

import { durationMs } from "../stepPolicy.ts";
import { eventTriggerProblem } from "./eventTriggers.ts";
import { evaluateLiteral } from "./literals.ts";
import type { WorkflowSource } from "./source.ts";

const decodeMeta = Schema.decodeUnknownResult(WorkflowMeta);
const formatIssue = SchemaIssue.makeFormatterDefault();

const META_HINT =
  'Write meta as a plain object, e.g. export const meta = { name: "Weekly report", triggers: [{ cron: "0 9 * * 1" }] } as const';

/**
 * Reads `export const meta = { … }`. It must be a pure literal so the server
 * can list the automation and schedule its triggers without running any code.
 */
export function readMeta(source: WorkflowSource, init: Node): WorkflowMeta | null {
  const literal = evaluateLiteral(init);
  if (!literal.ok) {
    source.error(
      init,
      "meta has to be a plain literal: no variables, calls, or computed values.",
      META_HINT,
    );
    return null;
  }
  const triggerProblem = eventTriggerProblem(
    literal.value && typeof literal.value === "object"
      ? (literal.value as { readonly triggers?: unknown }).triggers
      : undefined,
  );
  if (triggerProblem) {
    source.error(init, triggerProblem.message, triggerProblem.hint);
    return null;
  }
  const decoded = decodeMeta(literal.value);
  if (Result.isFailure(decoded)) {
    source.error(init, `meta is invalid: ${formatIssue(decoded.failure.issue)}`, META_HINT);
    return null;
  }
  const meta = decoded.success;
  if (meta.timeout !== undefined && durationMs(meta.timeout) === null) {
    source.error(
      init,
      "meta.timeout needs an amount, like { hours: 2 }.",
      "Use seconds, minutes, hours or days; they add up.",
    );
    return null;
  }
  for (const trigger of meta.triggers ?? []) {
    if (!("cron" in trigger)) continue;
    const parsed = Cron.parse(trigger.cron, trigger.timezone);
    if (Result.isFailure(parsed)) {
      source.error(
        init,
        `meta.triggers has an invalid cron "${trigger.cron}": ${parsed.failure.message}`,
        'Use five fields: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1" for Mondays at 9:00.',
      );
      return null;
    }
  }
  return meta;
}
