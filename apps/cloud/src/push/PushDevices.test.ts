import type { SignalboxPushDeviceRegistration } from "@t3tools/contracts/signalboxPush";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeMemoryCloud } from "../testing.ts";
import * as PushDevices from "./PushDevices.ts";

const registration = (
  deviceId: string,
  pushToken?: string,
  notificationsEnabled = true,
): SignalboxPushDeviceRegistration => ({
  deviceId,
  label: "Test phone",
  platform: "ios",
  iosMajorVersion: 26,
  bundleId: "com.justyannicc.signalbox",
  apsEnvironment: "production",
  ...(pushToken === undefined ? {} : { pushToken }),
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
});

const summary = (devices: ReadonlyArray<PushDevices.PushDevice>) =>
  devices.map(({ deviceId, sid, pushToken }) => ({ deviceId, sid, pushToken }));

describe("PushDevices", () => {
  it.effect("replaces the session and token for one phone, then deduplicates a reinstall", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const results = yield* Effect.gen(function* () {
        const devices = yield* PushDevices.PushDevices;
        yield* devices.register("session-1", registration("phone-1", "token-old"));
        yield* devices.register("session-2", registration("phone-1", "token-rotated"));
        const rotated = summary(yield* devices.list);

        // Reinstalling keeps the token but changes the app's device id.
        yield* devices.register("session-3", registration("phone-reinstalled", "token-rotated"));
        return { rotated, reinstalled: summary(yield* devices.list) };
      }).pipe(Effect.provide(cloud.layerFor("user-1")));

      expect(results.rotated).toEqual([
        { deviceId: "phone-1", sid: "session-2", pushToken: "token-rotated" },
      ]);
      expect(results.reinstalled).toEqual([
        { deviceId: "phone-reinstalled", sid: "session-3", pushToken: "token-rotated" },
      ]);
    }),
  );

  it.effect("forgets a phone with notifications disabled and no token, and on unregister", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const results = yield* Effect.gen(function* () {
        const devices = yield* PushDevices.PushDevices;
        yield* devices.register("session-1", registration("phone-1", "token-1"));
        yield* devices.register("session-1", registration("phone-1", undefined, false));
        const afterNotificationsOff = summary(yield* devices.list);

        yield* devices.register("session-1", registration("phone-1", "token-1"));
        yield* devices.remove("phone-1");
        const afterUnregister = summary(yield* devices.list);
        return { afterNotificationsOff, afterUnregister };
      }).pipe(Effect.provide(cloud.layerFor("user-1")));

      expect(results.afterNotificationsOff).toEqual([]);
      expect(results.afterUnregister).toEqual([]);
    }),
  );

  it.effect("keeps registrations and unregisters inside their cloud account", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const registerFor = (userId: string, sid: string, pushToken: string) =>
        Effect.gen(function* () {
          const devices = yield* PushDevices.PushDevices;
          yield* devices.register(sid, registration("phone-1", pushToken));
        }).pipe(Effect.provide(cloud.layerFor(userId)));
      const listFor = (userId: string) =>
        PushDevices.PushDevices.use((devices) => Effect.map(devices.list, summary)).pipe(
          Effect.provide(cloud.layerFor(userId)),
        );
      const removeFor = (userId: string) =>
        PushDevices.PushDevices.use((devices) => devices.remove("phone-1")).pipe(
          Effect.provide(cloud.layerFor(userId)),
        );

      yield* registerFor("user-a", "session-a", "token-a");
      yield* registerFor("user-b", "session-b", "token-b");
      expect(yield* listFor("user-a")).toEqual([
        { deviceId: "phone-1", sid: "session-a", pushToken: "token-a" },
      ]);
      expect(yield* listFor("user-b")).toEqual([
        { deviceId: "phone-1", sid: "session-b", pushToken: "token-b" },
      ]);

      yield* removeFor("user-a");
      expect(yield* listFor("user-a")).toEqual([]);
      expect(yield* listFor("user-b")).toEqual([
        { deviceId: "phone-1", sid: "session-b", pushToken: "token-b" },
      ]);
    }),
  );
});
