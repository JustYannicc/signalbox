import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  Automation,
  AutomationDetail,
  AutomationError,
  AutomationNotice,
  AutomationRetryVersion,
  AutomationRunDetail,
  AutomationRunAttach,
  AutomationRunSummary,
} from "./automation.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** Makes the pending draft the live version. */
const PublishRpc = Rpc.make(AUTOMATION_WS_METHODS.automationsPublish, {
  payload: Schema.Struct({ automationId: AutomationId }),
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

export const AutomationRpcs = [
  SubscribeRpc,
  SubscribeOneRpc,
  SubscribeRunRpc,
  SetEnabledRpc,
  DeleteRpc,
  RotateWebhookRpc,
  SetWebhookSecretRpc,
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
] as const;
