import {
  RELAY_AUTOMATION_NOTIFICATION_TYP,
  RelayApi,
  type RelayAutomationNotification,
  type RelayAutomationNotificationProofPayload,
} from "@t3tools/contracts/relay";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  readRelayLink,
  readRelaySecret,
  relayEnvironmentClient,
  relayEnvironmentProofClaims,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import { logFailure } from "./errors.ts";
import { relayNotificationForNotice } from "./notices.ts";
import { WorkflowEngine } from "./WorkflowEngine.ts";

/**
 * Sends automation notices to the user's phones through the Signalbox Connect
 * relay. Uses the same link and opt-in as agent activity: an unlinked or
 * self-hosted server without a relay sends nothing. Delivery is at most once
 * per step; a relay that stays down past the retries drops the alert.
 */

export const make = Effect.gen(function* () {
  const engine = yield* WorkflowEngine;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);

  /** The relay link, or null when this server shouldn't publish. */
  const relayLink = Effect.gen(function* () {
    const enabled = yield* readRelaySecret(secrets, PUBLISH_AGENT_ACTIVITY_SECRET);
    const link = yield* readRelayLink(secrets);
    return isAgentActivityPublishingEnabledValue(enabled) ? link : null;
  });

  const send = (input: {
    readonly link: NonNullable<Effect.Success<typeof relayLink>>;
    readonly environmentId: string;
    readonly notification: RelayAutomationNotification;
  }) =>
    Effect.gen(function* () {
      const payload = {
        ...(yield* relayEnvironmentProofClaims({
          relayIssuer: input.link.issuer,
          environmentId: input.environmentId,
          jti: yield* crypto.randomUUIDv4,
        })),
        notification: input.notification,
      } satisfies RelayAutomationNotificationProofPayload;
      const proof = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: RELAY_AUTOMATION_NOTIFICATION_TYP,
        payload,
      });
      const client = yield* HttpApiClient.make(RelayApi, {
        baseUrl: input.link.url,
        transformClient: relayEnvironmentClient(input.link.environmentCredential),
      });
      return yield* client.automationNotifications.publishAutomationNotification({
        params: { environmentId: payload.environmentId },
        payload: { notification: input.notification, proof },
      });
    }).pipe(Effect.provide(FetchHttpClient.layer));

  const push = Effect.fn("AutomationPush.push")(function* (
    notice: Parameters<typeof relayNotificationForNotice>[0],
  ) {
    const link = yield* relayLink;
    if (!link) return;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const notification = relayNotificationForNotice(notice, environmentId);
    if (!notification) return;
    // Each attempt signs a fresh proof; the relay refuses a reused one.
    const response = yield* send({ link, environmentId, notification }).pipe(
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 2 }),
    );
    yield* Effect.logDebug("automation notification published", {
      noticeId: notice.id,
      deliveries: response.deliveries.length,
    });
  });

  // Subscribe now, before activation, so recovery after a restart can't announce unheard.
  const notices = yield* engine.subscribeNotices;
  yield* forkParked(
    Stream.runForEach(notices, (notice) =>
      push(notice).pipe(
        logFailure("automation notification not delivered", { noticeId: notice.id }),
      ),
    ),
  );
});

/** Starts the push worker. Fork wiring only; no service to depend on. */
export const layer = Layer.effectDiscard(make);
