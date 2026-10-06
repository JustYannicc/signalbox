import {
  ProjectId,
  ThreadId,
  type Automation,
  type AutomationRunSummary,
  type AutomationStep,
  type AutomationWaitingQuestion,
  type WorkflowTrigger,
} from "@t3tools/contracts";
import { ellipsize } from "@t3tools/shared/String";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import { automationTriggers, errorDetailOf, stepArgs, stepAsk } from "./columns.ts";
import { fromJson } from "./json.ts";
import type { AutomationRow, RunSummaryRow, StepRow, WaitingAskRow } from "./WorkflowStore.ts";

/** Stored rows as the contracts clients and agents see. */

/** Where an automation with a `{ webhook: true }` trigger listens. The token is the only credential. */
export const AUTOMATION_WEBHOOK_ROUTE = "/api/automations/hooks/:token";
const automationWebhookPath = (token: string) => AUTOMATION_WEBHOOK_ROUTE.replace(":token", token);

export function runSummary(row: RunSummaryRow): AutomationRunSummary {
  return {
    id: row.run_id,
    automationId: row.automation_id,
    version: row.version,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    errorDetail: errorDetailOf(row.error_detail_json),
    waitingOnYou: row.waiting_on_you === 1,
    title: row.title,
    retryOf: row.retry_of_run_id,
  };
}

const TITLE_LENGTH = 80;
const shorten = (text: string) => ellipsize(text.replace(/\s+/g, " ").trim(), TITLE_LENGTH);

/**
 * A finished run's one-line title for run lists: the message of its last
 * notification, else a short text output. Null when neither says anything.
 */
export function runTitle(
  steps: ReadonlyArray<Pick<StepRow, "verb" | "status" | "args_json">>,
  output: unknown,
): string | null {
  for (const step of steps.toReversed()) {
    if (step.verb !== "notify" || step.status !== "succeeded") continue;
    const message = stepArgs(step)[0];
    if (typeof message === "string" && message.trim()) return shorten(message);
  }
  return typeof output === "string" && output.trim() ? shorten(output) : null;
}

function waitingQuestion(step: WaitingAskRow): AutomationWaitingQuestion {
  const { ask } = stepAsk(step);
  return {
    runId: step.run_id,
    stepKey: step.step_key,
    label: step.label,
    question: ask.question,
    options: ask.options,
    multi: ask.multi,
    fields: ask.fields,
    since: step.started_at,
  };
}

export function automationView(
  row: AutomationRow,
  lastRun: RunSummaryRow | undefined,
  waiting: ReadonlyArray<WaitingAskRow> = [],
): Automation {
  const triggers = automationTriggers(row);
  return {
    id: row.automation_id,
    name: row.name,
    description: row.description,
    intent: row.intent,
    enabled: row.enabled === 1,
    version: row.version,
    draftVersion: row.draft_version,
    projectId: ProjectId.make(row.project_id),
    triggers,
    nextRunAt: row.next_run_at,
    webhookPath: triggers.some((trigger) => "webhook" in trigger)
      ? automationWebhookPath(row.webhook_token)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRun: lastRun ? runSummary(lastRun) : null,
    waiting: waiting.map(waitingQuestion),
  };
}

export function stepView(row: StepRow): AutomationStep {
  return {
    key: row.step_key,
    nodeId: row.node_id,
    verb: row.verb,
    label: row.label,
    status: row.status,
    threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
    args: fromJson(row.args_json),
    result: fromJson(row.result_json),
    error: row.error,
    errorDetail: errorDetailOf(row.error_detail_json),
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** The next time any cron trigger fires after `from`, or null when off or without cron triggers. */
export function nextRunAt(
  triggers: ReadonlyArray<WorkflowTrigger>,
  enabled: boolean,
  from: DateTime.Utc,
): string | null {
  if (!enabled) return null;
  let next: number | null = null;
  for (const trigger of triggers) {
    if (!("cron" in trigger)) continue;
    const cron = Cron.parse(trigger.cron, trigger.timezone);
    if (Result.isFailure(cron)) continue;
    const at = Cron.next(cron.success, from).getTime();
    next = next === null ? at : Math.min(next, at);
  }
  return next === null ? null : DateTime.formatIso(DateTime.makeUnsafe(next));
}
