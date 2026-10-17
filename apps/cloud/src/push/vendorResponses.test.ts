import { type AutomationNotice, EnvironmentId } from "@t3tools/contracts";
import type { SignalboxPushDeviceRegistration } from "@t3tools/contracts/signalboxPush";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { layerMemoryStore } from "../testing.ts";
import * as PushDevices from "./PushDevices.ts";
import * as PushNotifier from "./PushNotifier.ts";

const notice: AutomationNotice = {
  id: "run-deadline/notify",
  kind: "notify",
  automationId: "automation-1",
  runId: "run-deadline",
  stepKey: "notify",
  title: "Review is ready",
  body: "The changes need your go.",
  importance: "normal",
  at: "2026-10-17T12:00:00.000Z",
};

const registration = (platform: "ios" | "android"): SignalboxPushDeviceRegistration => ({
  deviceId: "phone-deadline",
  label: "Test phone",
  platform,
  ...(platform === "ios" ? { iosMajorVersion: 26 } : { androidApiLevel: 35 }),
  bundleId: "com.justyannicc.signalbox",
  pushToken: "deadline-token",
  preferences: {
    liveActivitiesEnabled: false,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
});

const credentials = (platform: "ios" | "android") =>
  Effect.promise(async (): Promise<Record<string, string>> => {
    const pair =
      platform === "ios"
        ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
            "sign",
            "verify",
          ])
        : await crypto.subtle.generateKey(
            {
              name: "RSASSA-PKCS1-v1_5",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            },
            true,
            ["sign", "verify"],
          );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
    return platform === "ios"
      ? { APNS_TEAM_ID: "DEADLINE_TEAM", APNS_KEY_ID: "DEADLINE_KEY", APNS_PRIVATE_KEY: pem }
      : {
          FCM_SERVICE_ACCOUNT: JSON.stringify({
            project_id: "signalbox-test",
            client_email: "push@example.com",
            private_key: pem,
          }),
        };
  });

const layerPushes = (http: Layer.Layer<HttpClient.HttpClient>, env: Record<string, string>) =>
  PushNotifier.layerWithDevices(EnvironmentId.make("cloud-test"), () => Effect.succeed(true)).pipe(
    Layer.provide(Layer.mergeAll(http, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
    Layer.provide(layerMemoryStore),
  );

describe("push vendor responses", () => {
  it.effect.each([
    { platform: "ios", stage: "APNs rejection", status: 410, field: "text" },
    { platform: "android", stage: "FCM authorization", status: 200, field: "json" },
    { platform: "android", stage: "FCM rejection", status: 404, field: "text" },
  ] as const)("returns after the deadline when $stage headers arrive but its body stalls", (test) =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const body = Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      const requests: Array<string> = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request.url);
            if (request.url === "https://oauth2.googleapis.com/token" && test.field !== "json") {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ access_token: "google-token" }),
              );
            }
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: test.status }),
            );
            Object.defineProperty(response, test.field, { value: body });
            return response;
          }),
        ),
      );
      const layer = layerPushes(http, yield* credentials(test.platform));

      yield* Effect.gen(function* () {
        const devices = yield* PushDevices.PushDevices;
        const notifier = yield* PushNotifier.PushNotifier;
        yield* devices.register("session-deadline", registration(test.platform));
        const delivery = yield* notifier.automationNotice(notice).pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(reading);
        yield* TestClock.adjust("5 seconds");

        expect(yield* Deferred.isDone(completed)).toBe(true);
        expect(yield* Deferred.isDone(interrupted)).toBe(true);
        yield* Fiber.join(delivery);
        expect((yield* devices.list).map((device) => device.deviceId)).toEqual(["phone-deadline"]);
      }).pipe(Effect.provide(layer));

      if (test.field === "json") {
        expect(requests).toEqual(["https://oauth2.googleapis.com/token"]);
      }
    }),
  );

  it.effect.each([
    { platform: "ios", status: 400 },
    { platform: "android", status: 500 },
    { platform: "ios", status: 410 },
  ] as const)("keeps $platform vendor detail out of labels on HTTP $status", (test) =>
    Effect.gen(function* () {
      const vendorBody = JSON.stringify({ reason: "unexpected vendor detail ".repeat(100) });
      const logs: Array<unknown> = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === "https://oauth2.googleapis.com/token"
                ? Response.json({ access_token: "google-token" })
                : new Response(vendorBody, { status: test.status }),
            ),
          ),
        ),
      );
      const left = yield* Effect.gen(function* () {
        const devices = yield* PushDevices.PushDevices;
        const notifier = yield* PushNotifier.PushNotifier;
        yield* devices.register("session-deadline", registration(test.platform));
        yield* notifier.automationNotice(notice);
        return yield* devices.list;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerPushes(http, yield* credentials(test.platform)),
            Logger.layer([Logger.make(({ message }) => void logs.push(message))]),
          ),
        ),
      );

      if (test.status === 410) {
        expect(left).toEqual([]);
        expect(logs).toContainEqual([
          "push not delivered",
          { platform: "ios", outcome: "gone", reason: "Unregistered" },
        ]);
      } else {
        expect(left).toHaveLength(1);
        expect(logs).toContainEqual([
          "push failed",
          {
            platform: test.platform,
            cause: expect.objectContaining({ reason: "rejected", cause: vendorBody }),
          },
        ]);
      }
    }),
  );
});
