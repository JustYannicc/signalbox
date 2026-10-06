import { AUTOMATION_WS_METHODS, type AutomationRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Rpc from "effect/rpc/Rpc";
import * as Stream from "effect/Stream";

import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { projectDefaults } from "./callerAccess.ts";
import * as ConnectionSettings from "./connectionSettings.ts";
import type * as WorkflowEngine from "./WorkflowEngine.ts";

const METHODS = AUTOMATION_WS_METHODS;
const attributes = (extra: Record<string, string> = {}) => ({
  "rpc.aggregate": "automations",
  ...extra,
});

/** A method's decoded payload, as its contract declares it. */
type Payload<Tag extends string> = Rpc.Payload<
  Rpc.ExtractTag<(typeof AutomationRpcs)[number], Tag>
>;

/**
 * WebSocket handlers for automations: each calls one engine or connections
 * method. Spread into ws.ts's handler map.
 */
export const automationRpcHandlers = (engine: WorkflowEngine.WorkflowEngine["Service"]) => ({
  [METHODS.automationsSubscribe]: (_input: Payload<typeof METHODS.automationsSubscribe>) =>
    observeRpcStream(
      METHODS.automationsSubscribe,
      engine.subscribeList().pipe(Stream.map((automations) => ({ automations }))),
      attributes(),
    ),
  [METHODS.automationsSubscribeNotices]: (
    _input: Payload<typeof METHODS.automationsSubscribeNotices>,
  ) =>
    observeRpcStream(
      METHODS.automationsSubscribeNotices,
      Stream.unwrap(engine.subscribeNotices),
      attributes(),
    ),
  [METHODS.automationsSubscribeOne]: (input: Payload<typeof METHODS.automationsSubscribeOne>) =>
    observeRpcStream(
      METHODS.automationsSubscribeOne,
      engine.subscribeAutomation(input.automationId),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsSubscribeRun]: (input: Payload<typeof METHODS.automationsSubscribeRun>) =>
    observeRpcStream(
      METHODS.automationsSubscribeRun,
      engine.subscribeRun(input.runId),
      attributes({ "automation.run_id": input.runId }),
    ),
  [METHODS.automationsSetEnabled]: (input: Payload<typeof METHODS.automationsSetEnabled>) =>
    observeRpcEffect(
      METHODS.automationsSetEnabled,
      engine.setEnabled(input.automationId, input.enabled),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsDelete]: (input: Payload<typeof METHODS.automationsDelete>) =>
    observeRpcEffect(
      METHODS.automationsDelete,
      engine.remove(input.automationId).pipe(Effect.as({})),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsRotateWebhook]: (input: Payload<typeof METHODS.automationsRotateWebhook>) =>
    observeRpcEffect(
      METHODS.automationsRotateWebhook,
      engine.rotateWebhook(input.automationId),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsSetWebhookSecret]: (
    input: Payload<typeof METHODS.automationsSetWebhookSecret>,
  ) =>
    observeRpcEffect(
      METHODS.automationsSetWebhookSecret,
      engine.setWebhookSecret({ automationId: input.automationId, secret: input.secret }),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsRunNow]: (input: Payload<typeof METHODS.automationsRunNow>) =>
    observeRpcEffect(
      METHODS.automationsRunNow,
      engine.startRun({
        automationId: input.automationId,
        input: input.input,
        trigger: "manual",
        attach: input.attach,
      }),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsCustomize]: (input: Payload<typeof METHODS.automationsCustomize>) =>
    observeRpcEffect(
      METHODS.automationsCustomize,
      projectDefaults(input.projectId).pipe(
        Effect.flatMap((defaults) =>
          engine.customize(input.automationId, { projectId: input.projectId, defaults }),
        ),
      ),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsStopAttached]: (input: Payload<typeof METHODS.automationsStopAttached>) =>
    observeRpcEffect(
      METHODS.automationsStopAttached,
      engine.cancelAttached(input.threadId).pipe(Effect.map((cancelled) => ({ cancelled }))),
      attributes({ "thread.id": input.threadId }),
    ),
  [METHODS.automationsCancelRun]: (input: Payload<typeof METHODS.automationsCancelRun>) =>
    observeRpcEffect(
      METHODS.automationsCancelRun,
      engine.cancelRun(input.runId).pipe(Effect.as({})),
      attributes({ "automation.run_id": input.runId }),
    ),
  [METHODS.automationsRetryRun]: (input: Payload<typeof METHODS.automationsRetryRun>) =>
    observeRpcEffect(
      METHODS.automationsRetryRun,
      engine.retryRun({ runId: input.runId, version: input.version }),
      attributes({ "automation.run_id": input.runId }),
    ),
  [METHODS.automationsPublish]: (input: Payload<typeof METHODS.automationsPublish>) =>
    observeRpcEffect(
      METHODS.automationsPublish,
      engine.publish(input.automationId),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsDiscardDraft]: (input: Payload<typeof METHODS.automationsDiscardDraft>) =>
    observeRpcEffect(
      METHODS.automationsDiscardDraft,
      engine.discardDraft(input.automationId),
      attributes({ "automation.id": input.automationId }),
    ),
  [METHODS.automationsAnswer]: (input: Payload<typeof METHODS.automationsAnswer>) =>
    observeRpcEffect(
      METHODS.automationsAnswer,
      engine.answer(input).pipe(Effect.as({})),
      attributes({ "automation.run_id": input.runId }),
    ),
  [METHODS.automationsConnectionStatus]: (
    _input: Payload<typeof METHODS.automationsConnectionStatus>,
  ) =>
    observeRpcEffect(
      METHODS.automationsConnectionStatus,
      ConnectionSettings.AutomationConnections.use((connections) => connections.status),
      attributes(),
    ),
  [METHODS.automationsConnect]: (input: Payload<typeof METHODS.automationsConnect>) =>
    observeRpcEffect(
      METHODS.automationsConnect,
      ConnectionSettings.AutomationConnections.use((connections) => connections.connect(input)),
      attributes(),
    ),
  [METHODS.automationsDisconnect]: (_input: Payload<typeof METHODS.automationsDisconnect>) =>
    observeRpcEffect(
      METHODS.automationsDisconnect,
      ConnectionSettings.AutomationConnections.use((connections) => connections.disconnect),
      attributes(),
    ),
});
