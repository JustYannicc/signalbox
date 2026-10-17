import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";

import { makeDeviceLeaseAccess } from "./DeviceLeaseAccess.ts";
import { makeDeviceLeaseJanitor } from "./DeviceLeaseJanitor.ts";
import {
  DEVICE_IDLE_TIMEOUT_MS,
  deviceLeaseKey,
  type DeviceLeaseRecord,
  type DeviceLeaseTarget,
} from "./DeviceLease.ts";
import { makeDeviceLeaseCoordinator } from "./DeviceLeaseCoordinator.ts";
import { makeMemoryDeviceLeaseStore } from "./DeviceLeaseStore.ts";

const now = 2_000_000_000;
const deadPanel = {
  sessionId: "panel-1",
  leaseId: "lease-1",
  threadId: ThreadId.make("thread-1"),
  kind: "panel" as const,
  processId: 99,
  processIdentity: "old-process",
  openedAt: "2026-10-17T00:00:00.000Z",
  lastActivityAt: now - DEVICE_IDLE_TIMEOUT_MS - 1,
  lastHeartbeatAt: now - DEVICE_IDLE_TIMEOUT_MS - 1,
};

const lease: DeviceLeaseRecord = {
  version: 1,
  leaseId: "lease-1",
  state: "ready",
  deviceBooted: true,
  hostId: LOCAL_DEVICE_HOST_ID,
  platform: "android",
  canonicalDeviceId: "avd:Pixel_API_35",
  deviceId: "emulator-5554",
  aliases: ["emulator-5554", "Pixel_API_35", "avd:Pixel_API_35"],
  deviceName: "Pixel_API_35",
  physical: false,
  bootedBySignalbox: true,
  lastDeviceActivityAt: now - DEVICE_IDLE_TIMEOUT_MS - 1,
  owners: [deadPanel],
};

const fixture = (liveness: "live" | "dead" | "unknown") =>
  Effect.gen(function* () {
    const store = yield* makeMemoryDeviceLeaseStore;
    const key = `${LOCAL_DEVICE_HOST_ID}\u0000avd:Pixel_API_35`;
    yield* store.write(
      key,
      liveness === "live"
        ? {
            ...lease,
            owners: [{ ...deadPanel, lastActivityAt: now, lastHeartbeatAt: now }],
          }
        : lease,
    );
    const access = makeDeviceLeaseAccess({
      store,
      processId: 41,
      processIdentity: "current-server",
      isOwnerProcessLive: (pid) => (pid === 99 ? liveness : "live"),
    });
    return { store, key, janitor: makeDeviceLeaseJanitor(access) };
  });

it.effect(
  "dry-runs an exact idle device without changing its lease, and apply claims that exact device",
  () =>
    Effect.gen(function* () {
      const { store, key, janitor } = yield* fixture("dead");
      const dryRun = yield* janitor.planIdleCleanup({
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("emulator-5554"),
        now,
        apply: false,
      });
      expect(dryRun).toMatchObject([
        { hostId: LOCAL_DEVICE_HOST_ID, deviceId: "emulator-5554", status: "would_shutdown" },
      ]);
      expect((yield* store.read(key))?.owners).toHaveLength(1);

      const applied = yield* janitor.planIdleCleanup({
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("emulator-5554"),
        now,
        apply: true,
      });
      expect(applied[0]).toMatchObject({ status: "shutdown_pending" });
      expect(applied[0]?.claim?.target.id).toBe("emulator-5554");
      expect((yield* store.read(key))?.state).toBe("shutting_down");
    }).pipe(Effect.scoped),
);

it.effect.each([
  { process: "live", reason: "active_owner" },
  { process: "unknown", reason: "unknown_owner" },
] as const)("preserves a $process owner", ({ process, reason }) =>
  Effect.gen(function* () {
    const { store, key, janitor } = yield* fixture(process);
    const items = yield* janitor.planIdleCleanup({
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("emulator-5554"),
      now,
      apply: true,
    });
    expect(items[0]).toMatchObject({ status: "skipped", reason });
    expect((yield* store.read(key))?.state).toBe("ready");
  }).pipe(Effect.scoped),
);

it.effect("reserves an unleased device during explicit shutdown so opens wait", () =>
  Effect.gen(function* () {
    const store = yield* makeMemoryDeviceLeaseStore;
    const access = makeDeviceLeaseAccess({
      store,
      processId: 41,
      processIdentity: "current-server",
      isOwnerProcessLive: () => "live",
    });
    const janitor = makeDeviceLeaseJanitor(access);
    const coordinator = yield* makeDeviceLeaseCoordinator({ access });
    const target: DeviceLeaseTarget = {
      hostId: LOCAL_DEVICE_HOST_ID,
      platform: "android",
      id: "emulator-5554",
      name: "Pixel_API_35",
      booted: true,
      physical: false,
    };

    const claim = yield* janitor.prepareExplicitShutdown({ target, leaseId: "manual-shutdown" });
    expect(claim).toMatchObject({ leaseId: "manual-shutdown", target: { id: "emulator-5554" } });
    const queued = yield* coordinator.acquire({
      target,
      caller: { kind: "panel", threadId: ThreadId.make("waiting-walk") },
      shouldBoot: false,
      waiterId: "waiting-walk",
    });
    expect(queued._tag).toBe("Waiting");
    expect((yield* store.read(deviceLeaseKey(target)))?.waiters).toHaveLength(1);

    const secondShutdown = yield* janitor
      .prepareExplicitShutdown({
        target,
        leaseId: "duplicate-shutdown",
      })
      .pipe(Effect.flip);
    expect(secondShutdown.reason).toBe("busy");
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect("refuses explicit shutdown when an unreadable host lease may hide an alias", () =>
  Effect.gen(function* () {
    const underlying = yield* makeMemoryDeviceLeaseStore;
    const store = {
      ...underlying,
      list: Effect.succeed([
        {
          key: `${LOCAL_DEVICE_HOST_ID}\u0000avd:Pixel_API_35`,
          unknownReason: "invalid lease record",
        },
      ]),
    };
    const access = makeDeviceLeaseAccess({
      store,
      processId: 41,
      processIdentity: "current-server",
      isOwnerProcessLive: () => "live",
    });
    const janitor = makeDeviceLeaseJanitor(access);
    const target: DeviceLeaseTarget = {
      hostId: LOCAL_DEVICE_HOST_ID,
      platform: "android",
      id: "emulator-5554",
      name: "Pixel_API_35",
      booted: true,
      physical: false,
    };

    const error = yield* janitor
      .prepareExplicitShutdown({
        target,
        leaseId: "manual-shutdown",
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("busy");
    expect(yield* underlying.read(deviceLeaseKey(target))).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("claims one idle device at a time so cancellation cannot strand a batch", () =>
  Effect.gen(function* () {
    const store = yield* makeMemoryDeviceLeaseStore;
    const second: DeviceLeaseRecord = {
      ...lease,
      leaseId: "lease-2",
      canonicalDeviceId: "avd:Pixel_API_36",
      deviceId: "emulator-5556",
      aliases: ["emulator-5556", "Pixel_API_36", "avd:Pixel_API_36"],
      deviceName: "Pixel_API_36",
    };
    yield* store.write(`${LOCAL_DEVICE_HOST_ID}\u0000avd:Pixel_API_35`, lease);
    yield* store.write(`${LOCAL_DEVICE_HOST_ID}\u0000avd:Pixel_API_36`, second);
    const janitor = makeDeviceLeaseJanitor(
      makeDeviceLeaseAccess({
        store,
        processId: 41,
        processIdentity: "current-server",
        isOwnerProcessLive: (pid) => (pid === 99 ? "dead" : "live"),
      }),
    );

    const items = yield* janitor.planIdleCleanup({ now, apply: true });
    expect(items.filter((item) => item.claim !== undefined)).toHaveLength(1);
    expect((yield* store.list).map((entry) => entry.lease?.state).toSorted()).toEqual([
      "ready",
      "shutting_down",
    ]);
  }).pipe(Effect.scoped),
);
