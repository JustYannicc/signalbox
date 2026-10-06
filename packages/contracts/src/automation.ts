import * as Schema from "effect/Schema";

import { AutomationAskField } from "./automationAsk.ts";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import {
  WorkflowDiagnostic,
  WorkflowGraph,
  WorkflowStepVerb,
  WorkflowTrigger,
} from "./workflow.ts";

export * from "./automationAsk.ts";

/**
 * Automations as users and agents see them: saved workflow files, their runs,
 * and each run's steps. `workflow.ts` holds the compiled graph these refer to.
 */

export const AutomationRunStatus = Schema.Literals(["running", "succeeded", "failed", "cancelled"]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

/** `waiting` steps finish from outside: an agent thread, an answer, a timer, an event. */
export const AutomationStepStatus = Schema.Literals(["running", "waiting", "succeeded", "failed"]);
export type AutomationStepStatus = typeof AutomationStepStatus.Type;

export const AutomationRunTrigger = Schema.Literals([
  "manual",
  "cron",
  "webhook",
  "automation",
  "event",
]);
export type AutomationRunTrigger = typeof AutomationRunTrigger.Type;

/** Which version a retry runs: the failed run's own (`same`, the default) or the live one (`latest`). */
export const AutomationRetryVersion = Schema.Literals(["same", "latest"]);
export type AutomationRetryVersion = typeof AutomationRetryVersion.Type;

/** What agent steps run with unless the code names a provider and model. Captured when saved. */
export const AutomationDefaults = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type AutomationDefaults = typeof AutomationDefaults.Type;

/**
 * What a failure means and what to do about it, when the engine knows: an
 * evlog structured error's `why`, `fix` and `link`. `error` keeps the message.
 */
export const AutomationErrorDetail = Schema.Struct({
  why: Schema.NullOr(Schema.String),
  fix: Schema.NullOr(Schema.String),
  link: Schema.NullOr(Schema.String),
});
export type AutomationErrorDetail = typeof AutomationErrorDetail.Type;

export const AutomationRunSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  automationId: TrimmedNonEmptyString,
  version: Schema.Int,
  status: AutomationRunStatus,
  trigger: AutomationRunTrigger,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
  /** Why the run failed and how to fix it, when known. */
  errorDetail: Schema.NullOr(AutomationErrorDetail),
  /** A step is waiting for someone to answer it. */
  waitingOnYou: Schema.Boolean,
  /** What the run did, in a line ("Looked at 3 issues"). Null while running or when the run said nothing. */
  title: Schema.NullOr(Schema.String),
  /** The failed or cancelled run this one retries. */
  retryOf: Schema.NullOr(Schema.String),
});
export type AutomationRunSummary = typeof AutomationRunSummary.Type;

/** A question an `ask` step is waiting on the user to answer. */
export const AutomationWaitingQuestion = Schema.Struct({
  runId: Schema.String,
  stepKey: Schema.String,
  label: Schema.String,
  /** The step's `question` option, when the code gave one. */
  question: Schema.NullOr(Schema.String),
  options: Schema.Array(Schema.String),
  /** Pick any number of options. */
  multi: Schema.Boolean,
  /** The form to fill in before answering. */
  fields: Schema.Array(AutomationAskField),
  since: IsoDateTime,
});
export type AutomationWaitingQuestion = typeof AutomationWaitingQuestion.Type;

export const Automation = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  /** `meta.intent`: what the user asked for, in their words. */
  intent: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  /** The live version, which triggers and runs use. 0 while the automation is only a draft. */
  version: Schema.Int,
  /** A saved draft that isn't live yet, newer than `version`. */
  draftVersion: Schema.NullOr(Schema.Int),
  projectId: ProjectId,
  triggers: Schema.Array(WorkflowTrigger),
  nextRunAt: Schema.NullOr(IsoDateTime),
  /** Server path to POST to when the automation has a webhook trigger. It contains the secret token. */
  webhookPath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastRun: Schema.NullOr(AutomationRunSummary),
  /** Every question waiting on the user across this automation's running runs, oldest first. */
  waiting: Schema.Array(AutomationWaitingQuestion),
});
export type Automation = typeof Automation.Type;

export const AutomationStep = Schema.Struct({
  key: Schema.String,
  nodeId: Schema.String,
  verb: WorkflowStepVerb,
  label: Schema.String,
  status: AutomationStepStatus,
  threadId: Schema.NullOr(ThreadId),
  args: Schema.Unknown,
  result: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  /** Why the step failed and how to fix it, when known. */
  errorDetail: Schema.NullOr(AutomationErrorDetail),
  /** Which try this is, from 1. Steps with `retry` count up while they retry. */
  attempt: Schema.Int,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type AutomationStep = typeof AutomationStep.Type;

/** A `console.*` line from the automation's code. `at` is the run's deterministic clock at the call. */
export const AutomationRunLog = Schema.Struct({
  level: Schema.Literals(["log", "info", "warn", "error", "debug"]),
  message: Schema.String,
  at: IsoDateTime,
});
export type AutomationRunLog = typeof AutomationRunLog.Type;

export const AutomationRunDetail = Schema.Struct({
  run: AutomationRunSummary,
  graph: WorkflowGraph,
  input: Schema.Unknown,
  output: Schema.Unknown,
  steps: Schema.Array(AutomationStep),
  /** Branch answers and loop counts, keyed like steps. */
  marks: Schema.Record(Schema.String, Schema.Unknown),
  /** What the code logged with `console`, up to where the run got. */
  logs: Schema.Array(AutomationRunLog),
});
export type AutomationRunDetail = typeof AutomationRunDetail.Type;

/** A saved version waiting to be published. Runs keep using the live version until then. */
export const AutomationDraft = Schema.Struct({
  version: Schema.Int,
  source: Schema.String,
  graph: WorkflowGraph,
  savedAt: IsoDateTime,
});
export type AutomationDraft = typeof AutomationDraft.Type;

export const AutomationDetail = Schema.Struct({
  automation: Automation,
  /** The live version's file and diagram; the draft's while nothing is published yet. */
  source: Schema.String,
  graph: WorkflowGraph,
  runs: Schema.Array(AutomationRunSummary),
  /** The pending draft, when there is one. */
  draft: Schema.NullOr(AutomationDraft),
});
export type AutomationDetail = typeof AutomationDetail.Type;

export const AutomationSaveInput = Schema.Struct({
  automationId: Schema.optional(TrimmedNonEmptyString),
  source: Schema.String,
  projectId: ProjectId,
  defaults: AutomationDefaults,
  /** Save without going live: triggers and runs keep the live version until it's published. */
  draft: Schema.optional(Schema.Boolean),
});
export type AutomationSaveInput = typeof AutomationSaveInput.Type;

/** A save either compiles and goes live, or returns what to fix. */
export const AutomationSaveResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), automation: Automation, graph: WorkflowGraph }),
  Schema.Struct({ ok: Schema.Literal(false), diagnostics: Schema.Array(WorkflowDiagnostic) }),
]);
export type AutomationSaveResult = typeof AutomationSaveResult.Type;

/** How much a notice may interrupt: `low` stays in the app, `high` should stay until seen. */
export const AutomationNoticeImportance = Schema.Literals(["low", "normal", "high"]);
export type AutomationNoticeImportance = typeof AutomationNoticeImportance.Type;

/**
 * Something an automation wants the user to see now: an `ask` started waiting
 * on them, a `notify` step ran, or a run failed. Each step produces at most one
 * notice, ever, and each run at most one `failed` notice.
 */
export const AutomationNotice = Schema.Struct({
  /** `<runId>/<stepKey>`, or `<runId>/failed`; stable, so clients can drop repeats. */
  id: Schema.String,
  kind: Schema.Literals(["ask", "notify", "failed"]),
  automationId: Schema.String,
  runId: Schema.String,
  /** The step's key; empty for `failed`. */
  stepKey: Schema.String,
  /** The automation's name. */
  title: Schema.String,
  /** The ask's question (else its label), the notify message, or why the run failed. */
  body: Schema.String,
  importance: AutomationNoticeImportance,
  at: IsoDateTime,
});
export type AutomationNotice = typeof AutomationNotice.Type;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
  automationId: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}
