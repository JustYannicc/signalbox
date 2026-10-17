import { DeviceId, LOCAL_DEVICE_HOST_ID, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { makeDeviceLeaseAccess } from "./DeviceLeaseAccess.ts";
import { makeDeviceLeaseCoordinator, type DeviceLeaseCaller } from "./DeviceLeaseCoordinator.ts";
import { canonicalDeviceId, deviceLeaseKey, type DeviceLeaseTarget } from "./DeviceLease.ts";
import { makeMemoryDeviceLeaseStore } from "./DeviceLeaseStore.ts";

const target: DeviceLeaseTarget = {
  hostId: LOCAL_DEVICE_HOST_ID,
  platform: "android",
  id: "Pixel_API_35",
  name: "Pixel_API_35",
  booted: false,
  physical: false,
};

const makeRuntime = Effect.gen(function* () {
  const store = yield* makeMemoryDeviceLeaseStore;
  const access = makeDeviceLeaseAccess({
    store,
    processId: 41,
    processIdentity: "server-start-41",
    isOwnerProcessLive: () => "live",
    isProviderSessionLive: () => Effect.succeed(true),
  });
  const coordinator = yield* makeDeviceLeaseCoordinator({ access });
  return { store, coordinator };
}).pipe(Effect.provide(NodeCrypto.layer));

const agent = (thread: string, session: string): DeviceLeaseCaller => ({
  kind: "agent",
  threadId: ThreadId.make(thread),
  providerSessionId: ProviderSessionId.make(session),
});

const open = (
  caller: DeviceLeaseCaller,
  waiterId: string,
  device = target,
  shouldBoot = false,
) => ({ target: device, caller, waiterId, shouldBoot });

it.effect("keeps FIFO waiters behind the whole live walk and releases exact canceled tickets", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime;
    const firstCaller = agent("walk-1", "provider-1");
    const secondCaller = agent("walk-2", "provider-2");
    const thirdCaller = agent("walk-3", "provider-3");

    const first = yield* coordinator.acquire(open(firstCaller, "first"));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;

    expect((yield* coordinator.acquire(open(secondCaller, "second")))._tag).toBe("Waiting");
    expect((yield* coordinator.acquire(open(thirdCaller, "third")))._tag).toBe("Waiting");
    let record = yield* store.read(deviceLeaseKey(target));
    expect(record?.waiters?.map((waiter) => waiter.waiterId)).toEqual(["second", "third"]);

    yield* coordinator.cancelWaiter({ target, waiterId: "second" });
    record = yield* store.read(deviceLeaseKey(target));
    expect(record?.waiters?.map((waiter) => waiter.waiterId)).toEqual(["third"]);

    const claims = yield* coordinator.release({
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make(target.id),
      threadId: firstCaller.threadId,
      sessionId: first.session.sessionId,
      leaseId: first.session.leaseId,
      caller: firstCaller,
    });
    expect(claims).toEqual([]);
    const third = yield* coordinator.acquire(open(thirdCaller, "third"));
    expect(third._tag).toBe("Acquired");
  }).pipe(Effect.scoped),
);

it.effect("lets a same-walk panel attach in either direction without stealing the walk", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime;
    const threadId = ThreadId.make("shared-walk");
    const panel = { kind: "panel", threadId } as const;
    const agentOwner = agent("shared-walk", "provider-shared");

    const first = yield* coordinator.acquire(open(panel, "panel-first"));
    expect(first._tag).toBe("Acquired");
    const second = yield* coordinator.acquire(open(agentOwner, "agent-second"));
    expect(second._tag).toBe("Acquired");
    let record = yield* store.read(deviceLeaseKey(target));
    expect(record?.owners.map((owner) => owner.kind).toSorted()).toEqual(["agent", "panel"]);
    expect(record?.owners.find((owner) => owner.kind === "panel")?.observer).toBe(true);

    const { store: reverseStore, coordinator: reverseCoordinator } = yield* makeRuntime;
    const reverseAgent = yield* reverseCoordinator.acquire(open(agentOwner, "agent-first"));
    expect(reverseAgent._tag).toBe("Acquired");
    const reversePanel = yield* reverseCoordinator.acquire(open(panel, "panel-second"));
    expect(reversePanel._tag).toBe("Acquired");
    record = yield* reverseStore.read(deviceLeaseKey(target));
    expect(record?.owners.map((owner) => owner.kind).toSorted()).toEqual(["agent", "panel"]);
    expect(reversePanel._tag === "Acquired" && reversePanel.session.observer).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect(
  "never gives two live provider sessions controller leases for one device_open target",
  () =>
    Effect.gen(function* () {
      const { store, coordinator } = yield* makeRuntime;
      const firstWalk = agent("same-thread", "provider-837");
      const secondWalk = agent("same-thread", "provider-868");
      const results = yield* Effect.all(
        [
          coordinator.acquire(open(firstWalk, "walk-837")),
          coordinator.acquire(open(secondWalk, "walk-868")),
        ],
        { concurrency: 2 },
      );
      expect(results.filter((result) => result._tag === "Acquired")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Waiting")).toHaveLength(1);
      const record = yield* store.read(deviceLeaseKey(target));
      expect(record?.owners).toHaveLength(1);
      expect(record?.owners[0]?.kind).toBe("agent");
      expect(record?.waiters).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("holds the controller lease for the whole provider walk lifetime", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime;
    const firstWalk = agent("same-thread", "provider-837");
    const secondWalk = agent("same-thread", "provider-868");

    const first = yield* coordinator.acquire(open(firstWalk, "walk-837"));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;

    const second = yield* coordinator.acquire(open(secondWalk, "walk-868"));
    expect(second._tag).toBe("Waiting");
    let record = yield* store.read(deviceLeaseKey(target));
    expect(record?.owners.map((owner) => owner.providerSessionId)).toEqual(["provider-837"]);
    expect(record?.waiters?.map((waiter) => waiter.providerSessionId)).toEqual(["provider-868"]);

    yield* coordinator.release({
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make(target.id),
      threadId: firstWalk.threadId,
      sessionId: first.session.sessionId,
      leaseId: first.session.leaseId,
      caller: firstWalk,
    });
    const afterRelease = yield* coordinator.acquire(open(secondWalk, "walk-868"));
    expect(afterRelease._tag).toBe("Acquired");
    record = yield* store.read(deviceLeaseKey(target));
    expect(record?.owners.map((owner) => owner.providerSessionId)).toEqual(["provider-868"]);
  }).pipe(Effect.scoped),
);

it.effect("expires orphaned FIFO tickets after the bounded open wait", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime;
    const firstWalk = agent("walk-1", "provider-1");
    const abandoned = agent("walk-2", "provider-2");
    const current = agent("walk-3", "provider-3");
    const first = yield* coordinator.acquire(open(firstWalk, "first"));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;
    expect((yield* coordinator.acquire(open(abandoned, "abandoned")))._tag).toBe("Waiting");

    const key = deviceLeaseKey(target);
    const record = yield* store.read(key);
    if (!record?.waiters) throw new Error("Expected a persisted waiter.");
    const now = yield* Clock.currentTimeMillis;
    yield* store.write(key, {
      ...record,
      waiters: record.waiters.map((waiter) => ({ ...waiter, queuedAt: now - 300_001 })),
    });

    expect((yield* coordinator.acquire(open(current, "current")))._tag).toBe("Waiting");
    expect((yield* store.read(key))?.waiters?.map((waiter) => waiter.waiterId)).toEqual([
      "current",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("keeps the AVD-name and booted-serial identities on one lease", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime;
    const caller = agent("boot-walk", "provider-boot");
    const reserved = yield* coordinator.acquire(open(caller, "boot", target, true));
    expect(reserved._tag).toBe("Acquired");
    if (reserved._tag !== "Acquired") return;

    const serialTarget: DeviceLeaseTarget = {
      ...target,
      id: "emulator-5554",
      booted: true,
    };
    const ready = yield* coordinator.finishOpen({
      key: reserved.session.leaseKey,
      sessionId: reserved.session.sessionId,
      leaseId: reserved.session.leaseId,
      target: serialTarget,
    });
    expect(ready.deviceId).toBe("emulator-5554");
    expect(canonicalDeviceId(target)).toBe(canonicalDeviceId(serialTarget));
    expect(deviceLeaseKey(target)).toBe(deviceLeaseKey(serialTarget));

    const contender = yield* coordinator.acquire(
      open(agent("other-walk", "provider-other"), "contender", target, true),
    );
    expect(contender._tag).toBe("Waiting");
    expect((yield* store.read(reserved.session.leaseKey))?.deviceId).toBe("emulator-5554");

    const releasedByAvdName = yield* coordinator.release({
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make(target.id),
      threadId: caller.threadId,
      sessionId: ready.sessionId,
      leaseId: ready.leaseId,
      caller,
    });
    expect(releasedByAvdName).toMatchObject([{ target: { id: "emulator-5554" } }]);
  }).pipe(Effect.scoped),
);

it.effect(
  "does not release another same-walk owner and shuts down only after the last exact owner",
  () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeRuntime;
      const threadId = ThreadId.make("shutdown-walk");
      const firstCaller = agent("shutdown-walk", "provider-shutdown");
      const secondCaller = { kind: "panel", threadId } as const;
      const first = yield* coordinator.acquire(open(firstCaller, "shutdown-agent", target, true));
      expect(first._tag).toBe("Acquired");
      if (first._tag !== "Acquired") return;
      const firstReady = yield* coordinator.finishOpen({
        key: first.session.leaseKey,
        sessionId: first.session.sessionId,
        leaseId: first.session.leaseId,
        target: { ...target, id: "emulator-5554", booted: true },
      });
      const second = yield* coordinator.acquire(
        open(secondCaller, "shutdown-panel", { ...target, id: "emulator-5554", booted: true }),
      );
      expect(second._tag).toBe("Acquired");
      if (second._tag !== "Acquired") return;

      const refused = yield* coordinator
        .release({
          threadId,
          sessionId: firstReady.sessionId,
          leaseId: firstReady.leaseId,
          caller: firstCaller,
          shutdown: true,
        })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("busy");

      const firstRelease = yield* coordinator.release({
        threadId,
        sessionId: firstReady.sessionId,
        leaseId: firstReady.leaseId,
        caller: firstCaller,
      });
      expect(firstRelease).toEqual([]);
      const finalRelease = yield* coordinator.release({
        threadId,
        sessionId: second.session.sessionId,
        leaseId: second.session.leaseId,
        caller: secondCaller,
      });
      expect(finalRelease).toHaveLength(1);
      expect(finalRelease[0]?.target.id).toBe("emulator-5554");
    }).pipe(Effect.scoped),
);
