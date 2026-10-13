import { AUTOMATION_WS_METHODS, type AutomationRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Rpc from "effect/rpc/Rpc";
import * as Stream from "effect/Stream";

import { projectDefaults } from "./callerAccess.ts";
import * as ConnectionSettings from "./connectionSettings.ts";
import type * as WorkflowEngine from "./WorkflowEngine.ts";

const METHODS = AUTOMATION_WS_METHODS;

const annotated = <A, E, R>(attributes: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  Effect.annotateCurrentSpan(attributes).pipe(Effect.andThen(effect));

const annotatedStream = <A, E, R>(
  attributes: Record<string, string>,
  stream: Stream.Stream<A, E, R>,
) => Stream.unwrap(Effect.annotateCurrentSpan(attributes).pipe(Effect.as(stream)));

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
    engine.subscribeList().pipe(Stream.map((automations) => ({ automations }))),
  [METHODS.automationsSubscribeNotices]: (
    _input: Payload<typeof METHODS.automationsSubscribeNotices>,
  ) => Stream.unwrap(engine.subscribeNotices),
  [METHODS.automationsSubscribeOne]: (input: Payload<typeof METHODS.automationsSubscribeOne>) =>
    annotatedStream(
      { "automation.id": input.automationId },
      engine.subscribeAutomation(input.automationId),
    ),
  [METHODS.automationsSubscribeRun]: (input: Payload<typeof METHODS.automationsSubscribeRun>) =>
    annotatedStream({ "automation.run_id": input.runId }, engine.subscribeRun(input.runId)),
  [METHODS.automationsSetEnabled]: (input: Payload<typeof METHODS.automationsSetEnabled>) =>
    annotated(
      { "automation.id": input.automationId },
      engine.setEnabled(input.automationId, input.enabled),
    ),
  [METHODS.automationsDelete]: (input: Payload<typeof METHODS.automationsDelete>) =>
    annotated(
      { "automation.id": input.automationId },
      engine.remove(input.automationId).pipe(Effect.as({})),
    ),
  [METHODS.automationsRotateWebhook]: (input: Payload<typeof METHODS.automationsRotateWebhook>) =>
    annotated({ "automation.id": input.automationId }, engine.rotateWebhook(input.automationId)),
  [METHODS.automationsSetWebhookSecret]: (
    input: Payload<typeof METHODS.automationsSetWebhookSecret>,
  ) =>
    annotated(
      { "automation.id": input.automationId },
      engine.setWebhookSecret({ automationId: input.automationId, secret: input.secret }),
    ),
  [METHODS.automationsRunNow]: (input: Payload<typeof METHODS.automationsRunNow>) =>
    annotated(
      { "automation.id": input.automationId },
      engine.startRun({
        automationId: input.automationId,
        input: input.input,
        trigger: "manual",
        attach: input.attach,
      }),
    ),
  [METHODS.automationsCustomize]: (input: Payload<typeof METHODS.automationsCustomize>) =>
    annotated(
      { "automation.id": input.automationId },
      projectDefaults(input.projectId).pipe(
        Effect.flatMap((defaults) =>
          engine.customize(input.automationId, { projectId: input.projectId, defaults }),
        ),
      ),
    ),
  [METHODS.automationsStopAttached]: (input: Payload<typeof METHODS.automationsStopAttached>) =>
    annotated(
      { "thread.id": input.threadId },
      engine.cancelAttached(input.threadId).pipe(Effect.map((cancelled) => ({ cancelled }))),
    ),
  [METHODS.automationsCancelRun]: (input: Payload<typeof METHODS.automationsCancelRun>) =>
    annotated(
      { "automation.run_id": input.runId },
      engine.cancelRun(input.runId).pipe(Effect.as({})),
    ),
  [METHODS.automationsRetryRun]: (input: Payload<typeof METHODS.automationsRetryRun>) =>
    annotated(
      { "automation.run_id": input.runId },
      engine.retryRun({ runId: input.runId, version: input.version }),
    ),
  [METHODS.automationsPublish]: (input: Payload<typeof METHODS.automationsPublish>) =>
    annotated({ "automation.id": input.automationId }, engine.publish(input.automationId)),
  [METHODS.automationsDiscardDraft]: (input: Payload<typeof METHODS.automationsDiscardDraft>) =>
    annotated({ "automation.id": input.automationId }, engine.discardDraft(input.automationId)),
  [METHODS.automationsAnswer]: (input: Payload<typeof METHODS.automationsAnswer>) =>
    annotated({ "automation.run_id": input.runId }, engine.answer(input).pipe(Effect.as({}))),
  [METHODS.automationsConnectionStatus]: (
    _input: Payload<typeof METHODS.automationsConnectionStatus>,
  ) => ConnectionSettings.AutomationConnections.use((connections) => connections.status),
  [METHODS.automationsConnect]: (input: Payload<typeof METHODS.automationsConnect>) =>
    ConnectionSettings.AutomationConnections.use((connections) => connections.connect(input)),
  [METHODS.automationsDisconnect]: (_input: Payload<typeof METHODS.automationsDisconnect>) =>
    ConnectionSettings.AutomationConnections.use((connections) => connections.disconnect),
});
