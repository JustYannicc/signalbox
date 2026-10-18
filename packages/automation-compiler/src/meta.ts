import { WorkflowMeta } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { Node } from "oxc-parser";

import { durationMs } from "@signalbox/automations/stepPolicy";
import { eventTriggerProblem } from "@signalbox/automations/compiler/eventTriggers";
import { evaluateLiteral, propertyKey, unwrap } from "./literals.ts";
import { compileSchemaContract } from "./schemaContract.ts";
import type { WorkflowSource } from "./source.ts";

const decodeMeta = Schema.decodeUnknownResult(WorkflowMeta);
const formatIssue = SchemaIssue.makeFormatterDefault();

const META_HINT =
  'Write meta as a plain object, e.g. export const meta = { name: "Weekly report", triggers: [{ cron: "0 9 * * 1" }] } as const';

/**
 * Reads `export const meta = { … }`. All values are literals except `input`
 * and `output`, which accept statically recognized Effect Schema expressions.
 */
export function readMeta(
  source: WorkflowSource,
  init: Node,
  schemaImports: ReadonlySet<string>,
): WorkflowMeta | null {
  const object = unwrap(init);
  if (object.type !== "ObjectExpression") {
    source.error(
      init,
      "meta has to be a plain object literal. Its input and output contracts must use Effect Schema.",
      META_HINT,
    );
    return null;
  }

  const literal: Record<string, unknown> = {};
  const fields = new Set<string>();
  for (const property of object.properties) {
    const key = propertyKey(property);
    if (key === null || property.type !== "Property" || property.shorthand) {
      source.error(
        init,
        "meta has to be a plain literal: no variables, calls, or computed values.",
        META_HINT,
      );
      return null;
    }
    if (fields.has(key)) {
      source.error(property, `meta can't declare "${key}" more than once.`);
      return null;
    }
    fields.add(key);

    if (key === "input" || key === "output") {
      const contract = compileSchemaContract(source, key, property.value, schemaImports);
      if (!contract) return null;
      literal[key] = contract;
      continue;
    }

    const value = evaluateLiteral(property.value);
    if (!value.ok) {
      source.error(
        property.value,
        "meta has to be a plain literal: no variables, calls, or computed values.",
        META_HINT,
      );
      return null;
    }
    literal[key] = value.value;
  }

  const triggerProblem = eventTriggerProblem(
    Object.hasOwn(literal, "triggers") ? literal.triggers : undefined,
  );
  if (triggerProblem) {
    source.error(init, triggerProblem.message, triggerProblem.hint);
    return null;
  }
  const decoded = decodeMeta(literal);
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
