import {
  AutomationDefaults,
  AutomationErrorDetail,
  AutomationRunLog,
  parseAutomationAsk,
  WorkflowTrigger,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { AutomationRow, RunRow, StepRow } from "./WorkflowStore.ts";

/**
 * Typed reads of the store's JSON columns. The engine wrote them from these
 * same shapes, so a failed decode is a bug, not user input.
 */

const decodeArgs = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const decodeTriggers = Schema.decodeSync(Schema.fromJsonString(Schema.Array(WorkflowTrigger)));
const decodeDefaults = Schema.decodeSync(Schema.fromJsonString(AutomationDefaults));
const decodeDetail = Schema.decodeSync(Schema.fromJsonString(AutomationErrorDetail));
const decodeLogs = Schema.decodeSync(Schema.fromJsonString(Schema.Array(AutomationRunLog)));
const decodeMarks = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** What the code passed the step besides its label. */
export const stepArgs = (step: Pick<StepRow, "args_json">): ReadonlyArray<unknown> =>
  decodeArgs(step.args_json);

/** An `ask` step's question, options and form. */
export const stepAsk = (step: Pick<StepRow, "args_json">) => parseAutomationAsk(stepArgs(step)[0]);

export const automationTriggers = (row: Pick<AutomationRow, "triggers_json">) =>
  decodeTriggers(row.triggers_json);

export const automationDefaults = (row: Pick<AutomationRow, "defaults_json">) =>
  decodeDefaults(row.defaults_json);

/** A step's or run's why/fix, when it has one. */
export const errorDetailOf = (text: string | null): AutomationErrorDetail | null =>
  text === null ? null : decodeDetail(text);

/** The latest replay's console lines. */
export const runLogLines = (run: Pick<RunRow, "logs_json">): ReadonlyArray<AutomationRunLog> =>
  run.logs_json === null ? [] : decodeLogs(run.logs_json);

/** Branch answers and loop counts, keyed like steps. */
export const runMarks = (run: Pick<RunRow, "marks_json">) => decodeMarks(run.marks_json);
