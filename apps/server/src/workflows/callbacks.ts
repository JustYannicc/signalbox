import { ScheduledTaskWebhookDeliveryId, type AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  WebhookTriggerRequest,
  WebhookTriggerResult,
} from "../scheduledTasks/ScheduledTaskService.ts";
import { constantTimeEquals } from "../scheduledTasks/webhookVerification.ts";
import type { Envelope } from "@signalbox/automations/events/eventTriggers";
import type { CallbackLink } from "@signalbox/automations/host";
import { nowIso } from "@signalbox/automations/time";
import { hookEndpoint } from "@signalbox/automations/views";
import { bodyInput, requestKeys, runHeaders, runQuery } from "./webhooks.ts";
import type { WorkflowStore } from "@signalbox/automations/WorkflowStore";

/**
 * `w.hook(label)`: a callback link a run hands to someone else, such as a
 * payment provider's "notify me" URL. It rides upstream's
 * `/api/hooks/:hookId/:token` route like automation webhooks, so it gets the
 * same relay URL and body cap. A request to it becomes a `hook.called` event
 * for the run that made it, and only that run, so a payload never lands in
 * other runs or triggers: `w.waitFor("…", { on: "hook.called", where: { hookId } })`.
 * A literal `on` keeps the event from the run's start, so a request racing the
 * wait isn't lost. Links stop answering when their run ends.
 */

/** Callback link ids are `callback_<uuid>`; automation and scheduled task ids never start this way. */
export const CALLBACK_HOOK_PREFIX = "callback_";

export const makeCallbacks = (deps: {
  readonly store: WorkflowStore;
  readonly newId: (prefix: string) => Effect.Effect<string, AutomationError>;
  readonly relayHookBaseUrl: Effect.Effect<string | null>;
  /** Delivers an event to one run's waiting steps. */
  readonly deliverTo: (runId: string, envelope: Envelope) => Effect.Effect<void, AutomationError>;
}) => {
  const { store } = deps;

  /** Makes a link for `runId`; `chosenId` when the caller named it before the run started. */
  const create = (runId: string, chosenId?: string) =>
    Effect.gen(function* () {
      const hookId = chosenId ?? (yield* deps.newId("callback"));
      const token = yield* deps.newId("token");
      yield* store.insertCallback({ hookId, runId, token, now: yield* nowIso });
      return {
        hookId,
        ...hookEndpoint(hookId, token, yield* deps.relayHookBaseUrl),
      } satisfies CallbackLink;
    });

  const receive = Effect.fn("automations.receiveCallback")(function* (
    request: WebhookTriggerRequest,
  ) {
    const row = yield* store.getCallback(request.hookId);
    const found = row && constantTimeEquals(request.token, row.token) ? row : undefined;
    const owner = found ? yield* store.getRun(found.run_id) : undefined;
    const automation = owner ? yield* store.getAutomation(owner.automation_id) : undefined;
    // A wrong token, an ended run and an unknown link look the same from outside.
    if (!owner || owner.status !== "running" || !automation)
      return { _tag: "not_found" } satisfies WebhookTriggerResult;
    // A sender's retry and the relay's redelivery are the same call.
    const id = `hook.called:${request.hookId}:${requestKeys(request)[0] ?? (yield* deps.newId("call"))}`;
    yield* deps.deliverTo(owner.run_id, {
      event: "hook.called",
      id,
      at: yield* nowIso,
      projectId: automation.project_id,
      hookId: request.hookId,
      method: request.method,
      body: bodyInput(request),
      query: runQuery(request),
      headers: runHeaders(request.headers),
    });
    return {
      _tag: "accepted",
      deliveryId: ScheduledTaskWebhookDeliveryId.make(id),
      outcome: "accepted",
    } satisfies WebhookTriggerResult;
  });

  /** A run ended: its links stop answering. */
  const ended = (runId: string) => store.deleteCallbacks(runId).pipe(Effect.asVoid);

  return { create, receive, ended };
};

export type Callbacks = ReturnType<typeof makeCallbacks>;
