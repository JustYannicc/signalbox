import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WebhookReceivers } from "../scheduledTasks/webhookRoute.ts";
import { CALLBACK_HOOK_PREFIX } from "./callbacks.ts";
import { AUTOMATION_HOOK_PREFIX } from "./webhooks.ts";
import { AutomationHooks } from "./serverHost.ts";

/**
 * Automation webhooks ride upstream's `/api/hooks/:hookId/:token` route, so
 * they get its Signalbox Connect URL, held requests and body cap: requests for
 * `automation_…` hook ids go to the engine (see webhooks.ts), and `callback_…`
 * ones are runs' `w.hook` links (see callbacks.ts).
 */
export const layerWebhookReceiver = Layer.effect(
  WebhookReceivers,
  Effect.gen(function* () {
    const hooks = yield* AutomationHooks;
    return [
      { hookIdPrefix: AUTOMATION_HOOK_PREFIX, trigger: hooks.receiveWebhook },
      { hookIdPrefix: CALLBACK_HOOK_PREFIX, trigger: hooks.receiveCallback },
    ];
  }),
);
