import { AutomationNoticeImportance, type AutomationNotice } from "@t3tools/contracts";
import { automationRunDeepLink, type RelayAutomationNotification } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

import { stepArgs, stepAsk } from "./columns.ts";
import { asRecord } from "./json.ts";
import type { AutomationRow, RunRow, StepRow } from "./WorkflowStore.ts";

/**
 * What the user hears about from automations, and where a tap takes them.
 * The engine calls `automationNotice` once per step transition and
 * `failureNotice` once per failed run; the push worker turns notices into
 * relay notifications.
 */

const isImportance = Schema.is(AutomationNoticeImportance);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The notice for a step that just started waiting on the user (`ask`) or just
 * ran (`notify`). Null for every other step.
 */
export function automationNotice(input: {
  readonly automation: Pick<AutomationRow, "automation_id" | "name">;
  readonly step: Pick<StepRow, "run_id" | "step_key" | "verb" | "label" | "args_json">;
  readonly at: string;
}): AutomationNotice | null {
  const { automation, step } = input;
  const notice = (
    kind: AutomationNotice["kind"],
    body: string,
    importance: AutomationNoticeImportance,
  ): AutomationNotice => ({
    id: `${step.run_id}/${step.step_key}`,
    kind,
    automationId: automation.automation_id,
    runId: step.run_id,
    stepKey: step.step_key,
    title: automation.name,
    body,
    importance,
    at: input.at,
  });
  switch (step.verb) {
    case "ask":
      // A run is blocked until someone answers, so asks always interrupt.
      return notice("ask", stepAsk(step).ask.question?.trim() || step.label, "high");
    case "notify": {
      const args = stepArgs(step);
      const message = typeof args[0] === "string" ? args[0].trim() : JSON.stringify(args[0] ?? "");
      const importance = text(asRecord(args[1]).importance);
      return notice(
        "notify",
        message || step.label,
        isImportance(importance) ? importance : "normal",
      );
    }
    default:
      return null;
  }
}

/**
 * The notice for a run that just failed. Runs nobody started by hand
 * interrupt; a manual run's owner is probably watching already.
 */
export function failureNotice(input: {
  readonly automation: Pick<AutomationRow, "automation_id" | "name">;
  readonly run: Pick<RunRow, "run_id" | "trigger">;
  readonly error: string;
  readonly at: string;
}): AutomationNotice {
  return {
    id: `${input.run.run_id}/failed`,
    kind: "failed",
    automationId: input.automation.automation_id,
    runId: input.run.run_id,
    stepKey: "",
    title: input.automation.name,
    body: input.error,
    importance: input.run.trigger === "manual" ? "normal" : "high",
    at: input.at,
  };
}

/** The notice for an automation whose event triggers just paused for starting too many runs. */
export function eventsPausedNotice(input: {
  readonly automation: Pick<AutomationRow, "automation_id" | "name">;
  readonly limit: number;
  readonly at: string;
  /** Its latest event-started run, for the notice's link. */
  readonly runId: string;
}): AutomationNotice {
  return {
    id: `${input.automation.automation_id}/events-paused/${input.at}`,
    kind: "failed",
    automationId: input.automation.automation_id,
    runId: input.runId,
    stepKey: "",
    title: input.automation.name,
    body: `Events started more than ${input.limit} runs in a minute, so its event triggers are paused. Save it, or switch it off and on, to resume. Raise maxRunsPerMinute on the trigger if that many is expected.`,
    importance: "high",
    at: input.at,
  };
}

/** The phone alert for a notice, or null when it shouldn't buzz a phone. */
export function relayNotificationForNotice(
  notice: AutomationNotice,
  environmentId: string,
): RelayAutomationNotification | null {
  if (notice.importance === "low") return null;
  return {
    id: notice.id,
    // Relays only know ask and notify; a failure alerts like a notify, with the title saying so.
    kind: notice.kind === "ask" ? "ask" : "notify",
    title: notice.kind === "failed" ? `${notice.title} failed` : notice.title,
    body: notice.body,
    deepLink: automationRunDeepLink(environmentId, notice.runId),
  };
}
