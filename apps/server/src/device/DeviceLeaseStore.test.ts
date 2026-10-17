import { LOCAL_DEVICE_HOST_ID } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  deviceLeaseDirectory,
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
