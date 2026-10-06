import {
  RELAY_AUTOMATION_NOTIFICATION_TYP,
  RelayAgentActivityPublishProofInvalidReason,
  RelayAgentAwarenessPreferences,
  RelayAutomationNotificationProofPayload,
  type RelayAutomationNotification,
  type RelayAutomationNotificationPublishRequest,
  type RelayDeliveryResult,
  type RelayPublishResponse,
} from "@t3tools/contracts/relay";
import { decodeRelayJwt, normalizeRelayIssuer, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import {
  environmentPublishReplayThumbprintData,
  formatEnvironmentPublishReplayThumbprint,
} from "../environments/EnvironmentPublishSignatures.ts";
import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import { automationAlertAllowed, type AutomationAndroidAlert } from "./automationAndroidAlert.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import * as LiveActivities from "./LiveActivities.ts";

/**
 * Signalbox automations: one-shot alerts ("an automation needs you", "an
 * automation says…"). They reuse the agent-activity push queues but never
 * touch activity rows, so Live Activities and widgets don't list them.
 */

const decodePreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferences),
);
const decodeProof = Schema.decodeUnknownEffect(RelayAutomationNotificationProofPayload);

export class AutomationNotificationProofExpired extends Schema.TaggedError<AutomationNotificationProofExpired>()(
  "AutomationNotificationProofExpired",
  {
    environmentId: Schema.String,
    notificationId: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' proof for automation notification '${this.notificationId}' expired at ${this.expiresAt}`;
  }
}

export class AutomationNotificationProofInvalid extends Schema.TaggedError<AutomationNotificationProofInvalid>()(
  "AutomationNotificationProofInvalid",
  {
    environmentId: Schema.String,
    notificationId: Schema.String,
    reason: RelayAgentActivityPublishProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "verify_proof",
      "validate_claims",
      "validate_expiration",
      "generate_replay_thumbprint",
      "consume_nonce",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' proof for automation notification '${this.notificationId}' is invalid during ${this.stage}: ${this.reason}`;
  }
}

/**
 * The iOS alert. The thread id stays empty: older app builds fall back to
 * `/threads/<env>/<threadId>` when they don't know the deep link, and an empty
 * id makes them open the app instead of a thread that doesn't exist.
 */
export function automationApnsNotification(
  environmentId: string,
  notification: RelayAutomationNotification,
): ApnsNotificationPayload {
  return {
    title: notification.title,
    body: notification.body,
    environmentId,
    threadId: "",
    deepLink: notification.deepLink,
  };
}

/** The Android alert fields the native handler renders; its id dedupes retries on the phone. */
export function automationAndroidAlert(
  environmentId: string,
  notification: RelayAutomationNotification,
): AutomationAndroidAlert {
  return {
    alert_id: JSON.stringify(["automation", environmentId, notification.id]),
    alert_group: JSON.stringify(["automation", environmentId, notification.deepLink]),
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: notification.deepLink,
  };
}

export type AutomationNotificationPublishError =
  | AutomationNotificationProofExpired
  | AutomationNotificationProofInvalid
  | DpopProofs.DpopProofReplayPersistenceError
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | ApnsDeliveryQueue.ApnsDeliveryQueueError
  | FcmDeliveries.FcmDeliveryError;

export class AutomationNotifications extends Context.Service<
  AutomationNotifications,
  {
    readonly publish: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly request: RelayAutomationNotificationPublishRequest;
    }) => Effect.Effect<RelayPublishResponse, AutomationNotificationPublishError>;
  }
>()("t3code-relay/agentActivity/AutomationNotifications") {}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const crypto = yield* Crypto.Crypto;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const liveActivities = yield* LiveActivities.LiveActivities;
  const apnsQueue = yield* ApnsDeliveryQueue.ApnsDeliveryQueue;
  const fcmDeliveries = yield* FcmDeliveries.FcmDeliveries;

  /** Same checks as agent-activity proofs, with this kind's `typ` and payload. */
  const verify = Effect.fnUntraced(function* (input: {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
    readonly request: RelayAutomationNotificationPublishRequest;
  }) {
    const notificationId = input.request.notification.id;
    const invalid = (stage: AutomationNotificationProofInvalid["stage"], cause?: unknown) =>
      new AutomationNotificationProofInvalid({
        environmentId: input.environmentId,
        notificationId,
        reason: "invalid_signature_or_payload",
        stage,
        ...(cause === undefined ? {} : { cause }),
      });
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const decoded = yield* Effect.try({
      try: () => decodeRelayJwt(input.request.proof),
      catch: (cause) => invalid("decode_token", cause),
    });
    if (typeof decoded.exp === "number" && decoded.exp <= nowSeconds) {
      return yield* new AutomationNotificationProofExpired({
        environmentId: input.environmentId,
        notificationId,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(decoded.exp * 1_000)),
      });
    }
    const proof = yield* verifyRelayJwt({
      publicKey: input.environmentPublicKey,
      token: input.request.proof,
      typ: RELAY_AUTOMATION_NOTIFICATION_TYP,
      issuer: `t3-env:${input.environmentId}`,
      audience: normalizeRelayIssuer(config.relayIssuer),
      nowEpochSeconds: nowSeconds,
    }).pipe(
      Effect.flatMap(decodeProof),
      Effect.mapError((cause) => invalid("verify_proof", cause)),
    );
    if (
      proof.environmentId !== input.environmentId ||
      proof.sub !== input.environmentId ||
      stableStringify(proof.notification) !== stableStringify(input.request.notification)
    ) {
      return yield* invalid("validate_claims");
    }
    const expiresAt = DateTime.make(proof.exp * 1_000);
    if (Option.isNone(expiresAt)) return yield* invalid("validate_expiration");
    // Shares the agent-activity replay namespace: one jti store per environment key.
    const thumbprint = yield* crypto
      .digest("SHA-256", environmentPublishReplayThumbprintData(input))
      .pipe(
        Effect.map(formatEnvironmentPublishReplayThumbprint),
        Effect.mapError((cause) => invalid("generate_replay_thumbprint", cause)),
      );
    const consumed = yield* proofReplay.consume({
      thumbprint,
      jti: proof.jti,
      iat: proof.iat,
      expiresAt: expiresAt.value,
    });
    if (!consumed) {
      return yield* new AutomationNotificationProofInvalid({
        environmentId: input.environmentId,
        notificationId,
        reason: "replayed_nonce",
        stage: "consume_nonce",
      });
    }
  });

  // Android decides at send time, like agent-activity alerts, so a preference
  // changed while the job waits still counts; iOS alerts are final once queued.
  const deliverToTarget = (
    environmentId: string,
    notification: RelayAutomationNotification,
    target: LiveActivities.TargetRow,
  ): Effect.Effect<
    RelayDeliveryResult | null,
    ApnsDeliveryQueue.ApnsDeliveryQueueError | FcmDeliveries.FcmDeliveryError
  > => {
    if (target.platform === "android") {
      return fcmDeliveries.enqueue({
        target,
        state: null,
        automation: {
          kind: notification.kind,
          alert: automationAndroidAlert(environmentId, notification),
        },
      });
    }
    const preferences = Option.getOrNull(decodePreferences(target.preferences_json));
    if (
      !config.apns ||
      !target.push_token ||
      !automationAlertAllowed(notification.kind, preferences)
    ) {
      return Effect.succeed(null);
    }
    return apnsQueue.enqueuePushNotification({
      userId: target.user_id,
      deviceId: target.device_id,
      token: target.push_token,
      bundleId: target.bundle_id,
      apsEnvironment: target.aps_environment,
      notification: automationApnsNotification(environmentId, notification),
    });
  };

  return AutomationNotifications.of({
    publish: Effect.fn("relay.automation_notifications.publish")(function* (input) {
      const { notification } = input.request;
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.automation_notification.kind": notification.kind,
      });
      yield* verify(input);
      const users = yield* links.listDeliveryUsersForEnvironment({
        environmentId: input.environmentId,
        environmentPublicKey: input.environmentPublicKey,
      });
      const deliveries = yield* Effect.forEach(
        users.filter((user) => user.notificationsEnabled),
        (user) =>
          liveActivities
            .listTargets({ userId: user.userId })
            .pipe(
              Effect.flatMap((targets) =>
                Effect.forEach(
                  targets,
                  (target) => deliverToTarget(input.environmentId, notification, target),
                  { concurrency: 4 },
                ),
              ),
            ),
        { concurrency: 4 },
      );
      return {
        ok: true,
        deliveries: deliveries
          .flat()
          .filter((delivery): delivery is RelayDeliveryResult => delivery !== null),
      };
    }),
  });
});

export const layer = Layer.effect(AutomationNotifications, make);
