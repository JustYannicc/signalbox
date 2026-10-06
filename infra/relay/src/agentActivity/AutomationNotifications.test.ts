import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import {
  RELAY_AUTOMATION_NOTIFICATION_TYP,
  type RelayAutomationNotification,
  type RelayAutomationNotificationProofPayload,
} from "@t3tools/contracts/relay";
import { RELAY_ACTIVITY_PUBLISH_TYP } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ApnsDeliveryQueue from "./ApnsDeliveryQueue.ts";
import * as AutomationNotifications from "./AutomationNotifications.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import * as LiveActivities from "./LiveActivities.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const device = (
  overrides: Partial<LiveActivities.TargetRow> & Pick<LiveActivities.TargetRow, "device_id">,
): LiveActivities.TargetRow => ({
  user_id: "user",
  platform: "ios",
  ios_major_version: 18,
  app_version: null,
  bundle_id: "com.t3tools.t3code.dev",
  aps_environment: "sandbox",
  push_token: `token-${overrides.device_id}`,
  push_to_start_token: null,
  preferences_json: encodeJson(preferences),
  activity_push_token: null,
  remote_start_queued_at: null,
  remote_started_at: null,
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
  ...overrides,
});
const notification: RelayAutomationNotification = {
  id: "run_1/s1",
  kind: "ask",
  title: "Ship it",
  body: "Ship v2 to prod?",
  deepLink: "/automations/env/runs/run_1",
};

function signTestJwt(payload: object, typ = RELAY_AUTOMATION_NOTIFICATION_TYP): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), keyPair.privateKey).toString("base64url")}`;
}

const proofFor = (
  signed: RelayAutomationNotification,
  options: { jti?: string; typ?: string } = {},
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const payload = {
      iss: "t3-env:env",
      aud: "https://relay.example.test",
      sub: "env",
      jti: options.jti ?? "jti-1",
      iat: Math.floor(now.epochMilliseconds / 1_000),
      exp: Math.floor(DateTime.add(now, { minutes: 5 }).epochMilliseconds / 1_000),
      environmentId: "env" as RelayAutomationNotificationProofPayload["environmentId"],
      notification: signed,
    } satisfies RelayAutomationNotificationProofPayload;
    return signTestJwt(payload, options.typ);
  });

function harness(targets: ReadonlyArray<LiveActivities.TargetRow>) {
  const apns: Array<
    Parameters<ApnsDeliveryQueue.ApnsDeliveryQueue["Service"]["enqueuePushNotification"]>[0]
  > = [];
  const fcm: Array<Parameters<FcmDeliveries.FcmDeliveries["Service"]["enqueue"]>[0]> = [];
  const consumed = new Set<string>();
  const result = (deviceId: string) => ({
    deviceId,
    kind: "push_notification" as const,
    ok: true,
    queued: true,
    apnsStatus: null,
    apnsReason: null,
    apnsId: null,
  });
  const services = Layer.mergeAll(
    NodeCryptoLayer.layer,
    Layer.succeed(RelayConfiguration.RelayConfiguration, config),
    Layer.succeed(DpopProofs.DpopProofReplay, {
      verifyAndConsume: () => Effect.die("unused"),
      consume: (input) =>
        Effect.sync(() => !consumed.has(input.jti) && Boolean(consumed.add(input.jti))),
      pruneExpired: Effect.void,
    }),
    Layer.mock(EnvironmentLinks.EnvironmentLinks)({
      listDeliveryUsersForEnvironment: () =>
        Effect.succeed([
          { userId: "user", notificationsEnabled: true, liveActivitiesEnabled: true },
          { userId: "muted", notificationsEnabled: false, liveActivitiesEnabled: true },
        ]),
    }),
    Layer.mock(LiveActivities.LiveActivities)({
      listTargets: ({ userId }) =>
        Effect.succeed(
          userId === "muted" ? [device({ device_id: "muted-phone", user_id: "muted" })] : targets,
        ),
    }),
    Layer.mock(ApnsDeliveryQueue.ApnsDeliveryQueue)({
      enqueuePushNotification: (input) =>
        Effect.sync(() => {
          apns.push(input);
          return result(input.deviceId);
        }),
    }),
    Layer.mock(FcmDeliveries.FcmDeliveries)({
      enqueue: (input) =>
        Effect.sync(() => {
          fcm.push(input);
          return result(input.target.device_id);
        }),
    }),
  );
  return { apns, fcm, layer: AutomationNotifications.layer.pipe(Layer.provide(services)) };
}

const publish = (request: { notification: RelayAutomationNotification; proof: string }) =>
  AutomationNotifications.AutomationNotifications.use((service) =>
    service.publish({ environmentId: "env", environmentPublicKey: keyPair.publicKey, request }),
  );

describe("AutomationNotifications", () => {
  it.effect("alerts every linked phone that wants it, and only those", () => {
    const h = harness([
      device({ device_id: "iphone" }),
      device({ device_id: "pixel", platform: "android", aps_environment: null }),
      device({ device_id: "no-token", push_token: null }),
      device({
        device_id: "no-input-alerts",
        preferences_json: encodeJson({ ...preferences, notifyOnInput: false }),
      }),
      // Android checks preferences when the job runs, so it's queued either way.
      device({
        device_id: "pixel-no-input-alerts",
        platform: "android",
        aps_environment: null,
        preferences_json: encodeJson({ ...preferences, notifyOnInput: false }),
      }),
    ]);
    return Effect.gen(function* () {
      const response = yield* publish({ notification, proof: yield* proofFor(notification) });
      expect(response.deliveries.map((delivery) => delivery.deviceId)).toEqual([
        "iphone",
        "pixel",
        "pixel-no-input-alerts",
      ]);
      expect(h.apns).toEqual([
        {
          userId: "user",
          deviceId: "iphone",
          token: "token-iphone",
          bundleId: "com.t3tools.t3code.dev",
          apsEnvironment: "sandbox",
          // No thread id: older apps would otherwise open a thread that doesn't exist.
          notification: {
            title: "Ship it",
            body: "Ship v2 to prod?",
            environmentId: "env",
            threadId: "",
            deepLink: "/automations/env/runs/run_1",
          },
        },
      ]);
      expect(h.fcm).toHaveLength(2);
      expect(
        h.fcm.map(({ target, state, automation }) => ({
          device: target.device_id,
          state,
          automation,
        }))[0],
      ).toEqual({
        device: "pixel",
        state: null,
        automation: {
          kind: "ask",
          alert: {
            alert_id: '["automation","env","run_1/s1"]',
            alert_group: '["automation","env","/automations/env/runs/run_1"]',
            alert_title: "Ship it",
            alert_body: "Ship v2 to prod?",
            alert_path: "/automations/env/runs/run_1",
          },
        },
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("a notify follows only the master switch", () => {
    const h = harness([
      device({
        device_id: "iphone",
        preferences_json: encodeJson({ ...preferences, notifyOnInput: false }),
      }),
    ]);
    const notify = { ...notification, kind: "notify" as const, body: "Shipped" };
    return Effect.gen(function* () {
      yield* publish({ notification: notify, proof: yield* proofFor(notify) });
      expect(h.apns.map((delivery) => delivery.notification.body)).toEqual(["Shipped"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("refuses tampered, replayed and agent-activity proofs before sending anything", () => {
    const h = harness([device({ device_id: "iphone" })]);
    const isInvalid = Schema.is(AutomationNotifications.AutomationNotificationProofInvalid);
    return Effect.gen(function* () {
      const tampered = yield* publish({
        notification: { ...notification, body: "Delete prod?" },
        proof: yield* proofFor(notification),
      }).pipe(Effect.flip);
      expect(isInvalid(tampered) && tampered.stage).toBe("validate_claims");

      const wrongKind = yield* publish({
        notification,
        proof: yield* proofFor(notification, { jti: "jti-2", typ: RELAY_ACTIVITY_PUBLISH_TYP }),
      }).pipe(Effect.flip);
      expect(isInvalid(wrongKind) && wrongKind.stage).toBe("verify_proof");

      const proof = yield* proofFor(notification, { jti: "jti-3" });
      yield* publish({ notification, proof });
      const replayed = yield* publish({ notification, proof }).pipe(Effect.flip);
      expect(isInvalid(replayed) && replayed.reason).toBe("replayed_nonce");
      expect(h.apns).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  });
});
