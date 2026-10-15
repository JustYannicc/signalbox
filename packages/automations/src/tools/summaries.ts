import {
  AutomationErrorDetail,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationStepStatus,
  AutomationWebhookRejection,
  WorkflowStepVerb,
  type Automation,
  type AutomationDetail,
  type AutomationRunDetail,
  type AutomationRunSummary,
  type AutomationSaveResult,
  type WorkflowDiagnostic,
  type WorkflowGraph,
  type WorkflowTrigger,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { outlineGraph } from "../outline.ts";

/**
 * What the automation tools return, and how engine views become it: flat
 * summaries, diagrams as text outlines, and triggers as one line each.
 */

const Diagnostic = Schema.Struct({
  line: Schema.Int,
  column: Schema.Int,
  message: Schema.String,
  hint: Schema.optional(Schema.String),
});

export const AutomationSummary = Schema.Struct({
  automationId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  projectId: Schema.String,
  enabled: Schema.Boolean,
  version: Schema.Int.annotate({
    description: "The live version, which triggers and runs use. 0 while it's only a draft.",
  }),
  draftVersion: Schema.NullOr(Schema.Int).annotate({
    description: "A saved draft that isn't live yet; publish it with automation_publish.",
  }),
  triggers: Schema.Array(Schema.String),
  nextRunAt: Schema.NullOr(Schema.String),
  webhook: Schema.NullOr(
    Schema.Struct({
      url: Schema.String.annotate({
        description:
          "Where senders call it. A full URL through Signalbox Connect, else a path on this server's address.",
      }),
      secretSet: Schema.Boolean.annotate({
        description: "Whether a signing secret is set (automation_set_webhook_secret).",
      }),
    }),
  ),
  lastRun: Schema.NullOr(
    Schema.Struct({
      runId: Schema.String,
      status: AutomationRunStatus,
      startedAt: Schema.String,
      waitingOnYou: Schema.Boolean,
    }),
  ),
  builtIn: Schema.optional(Schema.Boolean).annotate({
    description:
      "Runs Signalbox's built-in code: read-only. automation_customize makes it the project's own to edit.",
  }),
});

export const RunSummary = Schema.Struct({
  runId: Schema.String,
  status: AutomationRunStatus,
  trigger: AutomationRunTrigger,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(AutomationErrorDetail),
  waitingOnYou: Schema.Boolean,
  /** The run this one retries. */
  retryOf: Schema.NullOr(Schema.String),
});

export const ValidateResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), outline: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), diagnostics: Schema.Array(Diagnostic) }),
]);

export const SaveResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    automation: AutomationSummary,
    outline: Schema.String,
  }),
  Schema.Struct({ ok: Schema.Literal(false), diagnostics: Schema.Array(Diagnostic) }),
]);

export const ReadResult = Schema.Struct({
  automation: AutomationSummary,
  /** meta.intent: what the user asked for, in their words. */
  intent: Schema.NullOr(Schema.String),
  source: Schema.String,
  outline: Schema.String,
  /** The pending draft, when one was saved and not published yet. */
  draft: Schema.NullOr(
    Schema.Struct({ version: Schema.Int, source: Schema.String, outline: Schema.String }),
  ),
  runs: Schema.Array(RunSummary),
  /** Recent webhook requests turned away (bad signature, paused, rate limited, too old). */
  webhookRejections: Schema.Array(AutomationWebhookRejection),
});

export const RunReadResult = Schema.Struct({
  run: RunSummary,
  automationId: Schema.String,
  outline: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      verb: WorkflowStepVerb,
      label: Schema.String,
      status: AutomationStepStatus,
      threadId: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      errorDetail: Schema.NullOr(AutomationErrorDetail),
      attempt: Schema.Int,
      result: Schema.Unknown,
    }),
  ),
  output: Schema.Unknown,
  /** The newest console lines the code logged. */
  logs: Schema.Array(Schema.String),
});

/** One line per trigger: `cron 0 9 * * 1 (Europe/Zurich)`, `webhook`, `on turn.finished (all projects)`. */
function describeTrigger(trigger: WorkflowTrigger): string {
  if ("cron" in trigger)
    return `cron ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
  if ("webhook" in trigger) return "webhook";
  const on = typeof trigger.on === "string" ? trigger.on : trigger.on.join(" | ");
  return `on ${on}${trigger.scope === "all" ? " (all projects)" : ""}`;
}

export function automationSummary(automation: Automation): typeof AutomationSummary.Type {
  const { lastRun } = automation;
  return {
    automationId: automation.id,
    name: automation.name,
    description: automation.description,
    projectId: automation.projectId,
    enabled: automation.enabled,
    version: automation.version,
    draftVersion: automation.draftVersion,
    triggers: automation.triggers.map(describeTrigger),
    nextRunAt: automation.nextRunAt,
    webhook: automation.webhook
      ? {
          url: automation.webhook.url ?? automation.webhook.path,
          secretSet: automation.webhook.hasSecret,
        }
      : null,
    lastRun: lastRun
      ? {
          runId: lastRun.id,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          waitingOnYou: lastRun.waitingOnYou,
        }
      : null,
    ...(automation.builtIn ? { builtIn: true } : {}),
  };
}

export function runSummary(run: AutomationRunSummary): typeof RunSummary.Type {
  return {
    runId: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    errorDetail: run.errorDetail,
    waitingOnYou: run.waitingOnYou,
    retryOf: run.retryOf,
  };
}

export function validateResult(
  result:
    | { readonly ok: true; readonly graph: WorkflowGraph }
    | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> },
): typeof ValidateResult.Type {
  return result.ok
    ? { ok: true, outline: outlineGraph(result.graph) }
    : { ok: false, diagnostics: result.diagnostics };
}

export function saveResult(saved: AutomationSaveResult): typeof SaveResult.Type {
  return saved.ok
    ? {
        ok: true,
        automation: automationSummary(saved.automation),
        outline: outlineGraph(saved.graph),
      }
    : { ok: false, diagnostics: saved.diagnostics };
}

export function readResult(detail: AutomationDetail): typeof ReadResult.Type {
  return {
    automation: automationSummary(detail.automation),
    intent: detail.automation.intent,
    source: detail.source,
    outline: outlineGraph(detail.graph),
    draft: detail.draft
      ? {
          version: detail.draft.version,
          source: detail.draft.source,
          outline: outlineGraph(detail.draft.graph),
        }
      : null,
    runs: detail.runs.map(runSummary),
    webhookRejections: detail.webhookRejections,
  };
}

export function runReadResult(detail: AutomationRunDetail): typeof RunReadResult.Type {
  return {
    run: runSummary(detail.run),
    automationId: detail.run.automationId,
    outline: outlineGraph(detail.graph, detail.steps),
    steps: detail.steps.map((step) => ({
      key: step.key,
      verb: step.verb,
      label: step.label,
      status: step.status,
      threadId: step.threadId,
      error: step.error,
      errorDetail: step.errorDetail,
      attempt: step.attempt,
      result: step.result,
    })),
    output: detail.output,
    logs: detail.logs.map((line) => `${line.at} ${line.level} ${line.message}`),
  };
}
