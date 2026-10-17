import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off - Seed and inspect the shared lock files in this test.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import {
  deviceLeaseDirectory,
  currentDeviceLeaseProcessIdentity,
  deviceLeaseProcessIdentity,
  makeFileDeviceLeaseStore,
} from "./DeviceLeaseStore.ts";
import type { DeviceLeaseRecord } from "./DeviceLease.ts";

const lease: DeviceLeaseRecord = {
  version: 1,
  leaseId: "lease-1",
  state: "ready",
  deviceBooted: true,
  hostId: LOCAL_DEVICE_HOST_ID,
  platform: "android",
  canonicalDeviceId: "avd:signalbox-pixel",
  deviceId: "emulator-5554",
  aliases: ["emulator-5554", "signalbox-pixel", "avd:signalbox-pixel"],
  deviceName: "signalbox-pixel",
  physical: false,
  bootedBySignalbox: true,
  lastDeviceActivityAt: 1,
  owners: [],
};

it("uses one home-scoped lease directory across worktrees", () => {
  expect(deviceLeaseDirectory("/home/alice")).toBe("/home/alice/.signalbox/device-leases");
});

it.effect("shares lease records between independent stores using the same root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "device-lease-store-" });
    const key = `${LOCAL_DEVICE_HOST_ID}\u0000avd:signalbox-pixel`;
    const first = makeFileDeviceLeaseStore(root);
    const second = makeFileDeviceLeaseStore(root);

    yield* first.write(key, lease);

    expect(yield* second.read(key)).toEqual(lease);
    expect(yield* second.list).toMatchObject([{ key, lease }]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "serializes stale reapers across two stores and fences release to its lock generation",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "device-lease-reaper-")),
      );
      const key = `${LOCAL_DEVICE_HOST_ID}\u0000avd:signalbox-pixel`;
      const operationLock = `${root}/${Buffer.from(key).toString("base64url")}.operation.lock`;
      const bothReapers = yield* Deferred.make<void>();
      const reapingAllowed = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const criticalSectionMayFinish = yield* Deferred.make<void>();
      let reaperCount = 0;
      let active = 0;
      let peak = 0;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(operationLock);
            await NodeFSP.writeFile(
              `${operationLock}/owner.json`,
              JSON.stringify({
                pid: 2_147_483_647,
                processIdentity: "dead-owner",
                token: "generation-a",
              }),
            );
          });
          const options = {
            waitAttempts: 20,
            waitInterval: 0,
            onDeadOwnerObserved: () =>
              Effect.gen(function* () {
                reaperCount++;
                if (reaperCount === 2) yield* Deferred.succeed(bothReapers, undefined);
                yield* Deferred.await(reapingAllowed);
              }),
          };
          const first = makeFileDeviceLeaseStore(root, options);
          const second = makeFileDeviceLeaseStore(root, options);
          const criticalSection = Effect.gen(function* () {
            active++;
            peak = Math.max(peak, active);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(criticalSectionMayFinish);
            active--;
          });
          const firstLock = yield* Effect.forkChild(first.withLock(key, criticalSection));
          const secondLock = yield* Effect.forkChild(second.withLock(key, criticalSection));
          yield* Deferred.await(bothReapers);
          expect(reaperCount).toBe(2);
          yield* Deferred.succeed(reapingAllowed, undefined);
          yield* Deferred.await(entered);
          expect(peak).toBe(1);
          yield* Deferred.succeed(criticalSectionMayFinish, undefined);
          yield* Fiber.join(firstLock);
          yield* Fiber.join(secondLock);
          expect(peak).toBe(1);

          yield* first.withLock(
            key,
            Effect.promise(async () => {
              await NodeFSP.rm(operationLock, { recursive: true, force: true });
              await NodeFSP.mkdir(operationLock);
              await NodeFSP.writeFile(
                `${operationLock}/owner.json`,
                JSON.stringify({
                  pid: process.pid,
                  processIdentity: currentDeviceLeaseProcessIdentity,
                  token: "generation-b",
                }),
              );
            }),
          );
          const replacementJson = yield* Effect.promise(() =>
            NodeFSP.readFile(`${operationLock}/owner.json`, "utf8"),
          );
          const replacement = JSON.parse(replacementJson) as { token: string };
          expect(replacement.token).toBe("generation-b");
        }),
        Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
    }),
);

it("keeps process start identity stable when the caller timezone changes", () => {
  const previousTimeZone = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utcIdentity = deviceLeaseProcessIdentity(process.pid);
    process.env.TZ = "Pacific/Honolulu";
    expect(deviceLeaseProcessIdentity(process.pid)).toBe(utcIdentity);
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});
