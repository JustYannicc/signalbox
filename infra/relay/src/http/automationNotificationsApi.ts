import {
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayApi,
  RelayAuthInvalidError,
  RelayEnvironmentPrincipal,
  RelayInternalError,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";

import * as AutomationNotifications from "../agentActivity/AutomationNotifications.ts";
import { mapErrorTags } from "./Api.ts";

/**
 * Signalbox automations: the relay endpoint that turns an automation notice
 * into phone alerts. Proof failures answer with the agent-activity proof
 * errors, so environments handle both publish routes the same way.
 */

const persistenceFailed = (_error: unknown, traceId: string) =>
  new RelayInternalError({ code: "internal_error", reason: "persistence_failed", traceId });

const upstreamUnavailable = (_error: unknown, traceId: string) =>
  new RelayInternalError({ code: "internal_error", reason: "upstream_unavailable", traceId });

export const automationNotificationsApi = HttpApiBuilder.group(
  RelayApi,
  "automationNotifications",
  Effect.fnUntraced(function* (handlers) {
    const notifications = yield* AutomationNotifications.AutomationNotifications;
    return handlers.handle(
      "publishAutomationNotification",
      Effect.fn("relay.api.automation_notifications.publish")(
        function* ({ params, payload }) {
          const principal = yield* RelayEnvironmentPrincipal;
          if (principal.environmentId !== params.environmentId) {
            return yield* new HttpApiError.Unauthorized({});
          }
          return yield* notifications.publish({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            request: payload,
          });
        },
        mapErrorTags({
          Unauthorized: (_error, traceId) =>
            new RelayAuthInvalidError({ code: "auth_invalid", reason: "not_authorized", traceId }),
          AutomationNotificationProofExpired: (_error, traceId) =>
            new RelayAgentActivityPublishProofExpiredError({
              code: "agent_activity_publish_proof_expired",
              traceId,
            }),
          AutomationNotificationProofInvalid: (_error, traceId) =>
            new RelayAgentActivityPublishProofInvalidError({
              code: "agent_activity_publish_proof_invalid",
              reason: "invalid_signature_or_payload",
              traceId,
            }),
          DpopProofReplayPersistenceError: persistenceFailed,
          EnvironmentLinkUserListPersistenceError: persistenceFailed,
          LiveActivityTargetListPersistenceError: persistenceFailed,
          ApnsDeliveryQueueSendError: upstreamUnavailable,
          FcmDeliveryError: upstreamUnavailable,
        }),
      ),
    );
  }),
);
