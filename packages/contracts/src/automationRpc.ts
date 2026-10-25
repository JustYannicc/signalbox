import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  Automation,
  AutomationDetail,
  AutomationSaveResult,
  AutomationError,
  AutomationNotice,
  AutomationRetryVersion,
  AutomationRunDetail,
  AutomationRunAttach,
  AutomationRunSummary,
} from "./automation.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkflowDiagnostic, WorkflowGraph, WorkflowMeta } from "./workflow.ts";
import { TaskLifecycleInput, TaskLifecycleResult } from "./taskLifecycle.ts";

/**
 * WebSocket methods for automations. Spread into `WS_METHODS` and `WsRpcGroup`
 * in rpc.ts, so the upstream file only carries two hook lines.
 */
export const AUTOMATION_WS_METHODS = {
  automationsSubscribe: "automations.subscribe",
  automationsSubscribeOne: "automations.subscribeOne",
  automationsSubscribeRun: "automations.subscribeRun",
  automationsSetEnabled: "automations.setEnabled",
  automationsDelete: "automations.delete",
  automationsRotateWebhook: "automations.rotateWebhook",
  automationsSetWebhookSecret: "automations.setWebhookSecret",
  automationsGitHubSubscriptions: "automations.githubSubscriptions",
  automationsRunNow: "automations.runNow",
  automationsCustomize: "automations.customize",
  automationsStopAttached: "automations.stopAttached",
  automationsCancelRun: "automations.cancelRun",
  automationsRetryRun: "automations.retryRun",
  automationsPublish: "automations.publish",
  automationsDiscardDraft: "automations.discardDraft",
  automationsAnswer: "automations.answer",
  automationsSubscribeNotices: "automations.subscribeNotices",
  automationsConnectionStatus: "automations.connectionStatus",
  automationsConnect: "automations.connect",
  automationsDisconnect: "automations.disconnect",
  automationsValidate: "automations.validate",
  automationsSave: "automations.save",
  automationsTaskLifecycle: "automations.taskLifecycle",
} as const;

const AutomationId = TrimmedNonEmptyString;
const RunId = TrimmedNonEmptyString;
const error = Schema.Union([AutomationError, EnvironmentAuthorizationError]);

/** The automation methods that stream; clients subscribe to these. */
export type AutomationSubscriptionRpcTag =
  | typeof AUTOMATION_WS_METHODS.automationsSubscribe
  | typeof AUTOMATION_WS_METHODS.automationsSubscribeOne
  | typeof AUTOMATION_WS_METHODS.automationsSubscribeRun
  | typeof AUTOMATION_WS_METHODS.automationsSubscribeNotices;

export const AutomationListResult = Schema.Struct({ automations: Schema.Array(Automation) });
export type AutomationListResult = typeof AutomationListResult.Type;

/** Every automation with its last run: once on subscribe, then after every change. */
const SubscribeRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSubscribe, {
  payload: Schema.Struct({}),
  success: AutomationListResult,
  error,
  stream: true,
});

/** One automation with its source, graph and recent runs, live. */
const SubscribeOneRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSubscribeOne, {
  payload: Schema.Struct({ automationId: AutomationId }),
  success: AutomationDetail,
  error,
  stream: true,
});

/** One run with its graph and steps, live. */
const SubscribeRunRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSubscribeRun, {
  payload: Schema.Struct({ runId: RunId }),
  success: AutomationRunDetail,
  error,
  stream: true,
});

const SetEnabledRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSetEnabled, {
  payload: Schema.Struct({ automationId: AutomationId, enabled: Schema.Boolean }),
  success: Automation,
  error,
});

const DeleteRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsDelete, {
  payload: Schema.Struct({ automationId: AutomationId }),
  success: Schema.Struct({}),
  error,
});

/** Replaces the webhook's secret token; the old URL stops working at once. */
const RotateWebhookRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsRotateWebhook, {
  payload: Schema.Struct({ automationId: AutomationId }),
  success: Automation,
  error,
});

/**
 * Sets or clears (null) the secret a webhook trigger's `signature` checks.
 * Write-only: it lives in the server's secret store and is never sent back.
 */
const SetWebhookSecretRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSetWebhookSecret, {
  payload: Schema.Struct({
    automationId: AutomationId,
    secret: Schema.NullOr(TrimmedNonEmptyString),
  }),
  success: Automation,
  error,
});

/** Installation state, including missing repository-admin access, never hook secrets or URLs. */
const GitHubSubscriptionsRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsGitHubSubscriptions, {
  payload: Schema.Struct({}),
  success: Schema.Struct({
    subscriptions: Schema.Array(
      Schema.Struct({
        projectId: ProjectId,
        repository: Schema.String,
        mode: Schema.Literals(["webhook", "release-poll", "unavailable"]),
        connected: Schema.Boolean,
        error: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  error,
});

const RunNowRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsRunNow, {
  payload: Schema.Struct({
    automationId: AutomationId,
    input: Schema.optional(Schema.Unknown),
    attach: Schema.optional(AutomationRunAttach),
  }),
  success: AutomationRunSummary,
  error,
});

/** Makes a built-in automation a project's own, editable automation; the project then runs it instead. */
const CustomizeRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsCustomize, {
  payload: Schema.Struct({ automationId: AutomationId, projectId: ProjectId }),
  success: Automation,
  error,
});

/** Stop on a thread: cancels the automation runs attached to it. */
const StopAttachedRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsStopAttached, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ cancelled: Schema.Int }),
  error,
});

const CancelRunRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsCancelRun, {
  payload: Schema.Struct({ runId: RunId }),
  success: Schema.Struct({}),
  error,
});

/**
 * Starts a new run that retries a failed or cancelled one: steps that went
 * well are reused, the failed step and everything after it run again. On the
 * run's own version by default, or on the live version after a fix.
 */
const RetryRunRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsRetryRun, {
  payload: Schema.Struct({
    runId: RunId,
    version: Schema.optional(AutomationRetryVersion),
  }),
  success: AutomationRunSummary,
  error,
});

/**
 * Makes the pending draft the live version. `version` is the draft the person
 * looked at: publishing it vouches for that code (it may then merge pull
 * requests), so a different pending draft is refused. Without it the draft
 * goes live but vouches for nothing.
 */
const PublishRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsPublish, {
  payload: Schema.Struct({ automationId: AutomationId, version: Schema.optional(Schema.Int) }),
  success: Automation,
  error,
});

/** Drops the pending draft; the live version stays as it is. */
const DiscardDraftRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsDiscardDraft, {
  payload: Schema.Struct({ automationId: AutomationId }),
  success: Automation,
  error,
});

/**
 * Answers a waiting `ask` step: `choice` is the option picked, `choices` the
 * options of a `multi` ask, and `values` its form's fields by name.
 */
const AnswerRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsAnswer, {
  payload: Schema.Struct({
    runId: RunId,
    stepKey: Schema.String,
    choice: Schema.optionalKey(Schema.String),
    choices: Schema.optionalKey(Schema.Array(Schema.String)),
    values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.Struct({}),
  error,
});

/**
 * Asks that start waiting and notify steps as they happen, for toasts. Live
 * only: nothing replays on subscribe, and each step produces one notice ever.
 */
const SubscribeNoticesRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSubscribeNotices, {
  payload: Schema.Struct({}),
  success: AutomationNotice,
  error,
  stream: true,
});

/** One account the user connected in Executor, e.g. `gmail` / `work`. `w.call` picks it by these names. */
export const AutomationConnectedService = Schema.Struct({
  integration: Schema.String,
  name: Schema.String,
});
export type AutomationConnectedService = typeof AutomationConnectedService.Type;

/**
 * Whether `w.call` can reach Executor, and what the user connected there.
 * Never carries the API key. `source` is "environment" when the server's env
 * vars set the connection, which settings can't change.
 */
export const AutomationConnectionStatus = Schema.Struct({
  configured: Schema.Boolean,
  source: Schema.NullOr(Schema.Literals(["settings", "environment"])),
  url: Schema.NullOr(Schema.String),
  services: Schema.Array(AutomationConnectedService),
  /** Why listing failed while configured, such as a revoked key or Executor being down. */
  error: Schema.NullOr(Schema.String),
});
export type AutomationConnectionStatus = typeof AutomationConnectionStatus.Type;

const ConnectionStatusRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsConnectionStatus, {
  payload: Schema.Struct({}),
  success: AutomationConnectionStatus,
  error,
});

/** Verifies the URL and key by listing connections, then saves them. */
const ConnectRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsConnect, {
  payload: Schema.Struct({ url: TrimmedNonEmptyString, apiKey: TrimmedNonEmptyString }),
  success: AutomationConnectionStatus,
  error,
});

const DisconnectRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsDisconnect, {
  payload: Schema.Struct({}),
  success: AutomationConnectionStatus,
  error,
});

/** What an automation file compiles to, or what to fix: the authoring loop's check. */
export const AutomationValidateResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), graph: WorkflowGraph }),
  Schema.Struct({ ok: Schema.Literal(false), diagnostics: Schema.Array(WorkflowDiagnostic) }),
]);
export type AutomationValidateResult = typeof AutomationValidateResult.Type;

/**
 * The format of `AutomationCompiled`. The compiler stamps it and a host reads
 * only its own, so a `signalbox` older or newer than the cloud is told to
 * update instead of saving code the cloud can't load.
 */
export const AUTOMATION_COMPILED_FORMAT = 2;

/**
 * An automation file compiled where the caller runs: the cloud can't compile
 * (its compiler, oxc, doesn't run in workerd). The `signalbox` CLI and stdio
 * `signalbox mcp` compile `source` on your computer and fill it in, as a cloud
 * thread's machine does for `automation_save`. The cloud checks its shape and
 * format; the code still runs only in its own isolate, as you.
 */
export const AutomationCompiled = Schema.Struct({
  format: Schema.Number,
  meta: WorkflowMeta,
  graph: WorkflowGraph,
  script: Schema.String,
  runModule: Schema.NullOr(Schema.String),
  workerModule: Schema.String,
});
export type AutomationCompiled = typeof AutomationCompiled.Type;

/**
 * An `AutomationCompiled`, loose on the wire: nobody writes one by hand, and
 * its schema would fill every agent's search for saving. The cloud decodes it.
 */
const compiledField = Schema.optional(
  Schema.Unknown.annotate({
    description:
      "`source`, compiled. The signalbox CLI and `signalbox mcp` fill this in; leave it out.",
  }),
);

/** Compiles a file without saving it; in the cloud, checks what the caller compiled. */
const ValidateRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsValidate, {
  payload: Schema.Struct({ source: Schema.String, compiled: compiledField }),
  success: AutomationValidateResult,
  error,
});

/**
 * Saves a file in a project, live unless `draft`: new without `automationId`,
 * a new version of that automation with it. A file that doesn't compile is
 * not saved; the result says what to fix. The cloud keeps the caller's compiled
 * code and resolves omitted cron zones into the saved scheduling metadata.
 */
const SaveRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsSave, {
  payload: Schema.Struct({
    source: Schema.String,
    projectId: ProjectId,
    automationId: Schema.optional(AutomationId),
    draft: Schema.optional(Schema.Boolean),
    compiled: compiledField,
  }),
  success: AutomationSaveResult,
  error,
});

/** Reads or changes a task's completion condition and lifecycle. */
const TaskLifecycleRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsTaskLifecycle, {
  payload: TaskLifecycleInput,
  success: TaskLifecycleResult,
  error,
});

export const AutomationRpcs = [
  SubscribeRpc,
  SubscribeOneRpc,
  SubscribeRunRpc,
  SetEnabledRpc,
  DeleteRpc,
  RotateWebhookRpc,
  SetWebhookSecretRpc,
  GitHubSubscriptionsRpc,
  RunNowRpc,
  CustomizeRpc,
  StopAttachedRpc,
  CancelRunRpc,
  RetryRunRpc,
  PublishRpc,
  DiscardDraftRpc,
  AnswerRpc,
  SubscribeNoticesRpc,
  ConnectionStatusRpc,
  ConnectRpc,
  DisconnectRpc,
  ValidateRpc,
  SaveRpc,
  TaskLifecycleRpc,
] as const;
