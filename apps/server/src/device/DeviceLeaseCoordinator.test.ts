import { DeviceId, LOCAL_DEVICE_HOST_ID, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeDeviceLeaseAccess } from "./DeviceLeaseAccess.ts";
import { makeDeviceLeaseCoordinator, type DeviceLeaseCaller } from "./DeviceLeaseCoordinator.ts";
import { makeDeviceLeaseJanitor } from "./DeviceLeaseJanitor.ts";
import {
  canonicalDeviceId,
  deviceLeaseKey,
  DEVICE_LEASE_WAITER_IDLE_TIMEOUT_MS,
  type DeviceLeaseRecord,
  type DeviceLeaseTarget,
  type DeviceOwnerLiveness,
} from "./DeviceLease.ts";
import { makeMemoryDeviceLeaseStore } from "./DeviceLeaseStore.ts";

const target: DeviceLeaseTarget = {
  hostId: LOCAL_DEVICE_HOST_ID,
  platform: "android",
  id: "Pixel_API_35",
  name: "Pixel_API_35",
  booted: false,
  physical: false,
};

const makeRuntime = (
  isProviderSessionLive: (id: ProviderSessionId) => Effect.Effect<boolean | null> = () =>
    Effect.succeed(true),
  isOwnerProcessLive: (pid: number, identity: string) => DeviceOwnerLiveness = () => "live",
) =>
  Effect.gen(function* () {
    const store = yield* makeMemoryDeviceLeaseStore;
    const access = makeDeviceLeaseAccess({
      store,
      processId: 41,
      processIdentity: "server-start-41",
      isOwnerProcessLive,
      isProviderSessionLive,
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
    const { store, coordinator } = yield* makeRuntime();
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
    const { store, coordinator } = yield* makeRuntime();
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

    const { store: reverseStore, coordinator: reverseCoordinator } = yield* makeRuntime();
    const reverseAgent = yield* reverseCoordinator.acquire(open(agentOwner, "agent-first"));
    expect(reverseAgent._tag).toBe("Acquired");
    const reversePanel = yield* reverseCoordinator.acquire(open(panel, "panel-second"));
    expect(reversePanel._tag).toBe("Acquired");
    record = yield* reverseStore.read(deviceLeaseKey(target));
    expect(record?.owners.map((owner) => owner.kind).toSorted()).toEqual(["agent", "panel"]);
    expect(reversePanel._tag === "Acquired" && reversePanel.session.observer).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("reuses the same panel owner when its open response is retried", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime();
    const caller = {
      kind: "panel",
      threadId: ThreadId.make("open-request-retry"),
      requestId: "open-request-retry-id",
    } as const;
    const first = yield* coordinator.acquire(open(caller, caller.requestId));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;

    const retried = yield* coordinator.acquire(open(caller, caller.requestId));
    expect(retried).toMatchObject({
      _tag: "Acquired",
      created: false,
      session: { sessionId: first.session.sessionId, requestId: caller.requestId },
    });
    expect((yield* store.read(deviceLeaseKey(target)))?.owners).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "never gives two live provider sessions controller leases for one device_open target",
  () =>
    Effect.gen(function* () {
      const { store, coordinator } = yield* makeRuntime();
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
    const { store, coordinator } = yield* makeRuntime();
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

it.effect("transfers the last lease to queued walks without shutting down or rebooting", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime();
    const firstCaller = agent("release-to-waiter-1", "provider-release-1");
    const waitingCaller = agent("release-to-waiter-2", "provider-release-2");
    const first = yield* coordinator.acquire(open(firstCaller, "first", target, true));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;
    const ready = yield* coordinator.finishOpen({
      key: first.session.leaseKey,
      sessionId: first.session.sessionId,
      leaseId: first.session.leaseId,
      target: { ...target, id: "emulator-5554", booted: true },
    });
    expect(
      (yield* coordinator.acquire(open(waitingCaller, "waiting", { ...target, booted: true })))
        ._tag,
    ).toBe("Waiting");

    const claims = yield* coordinator.release({
      threadId: firstCaller.threadId,
      sessionId: ready.sessionId,
      leaseId: ready.leaseId,
      caller: firstCaller,
    });
    expect(claims).toEqual([]);
    const held = yield* store.read(first.session.leaseKey);
    expect(held).toMatchObject({ state: "ready", deviceBooted: true, bootedBySignalbox: true });
    expect(held?.waiters?.map((waiter) => waiter.waiterId)).toEqual(["waiting"]);

    const transferred = yield* coordinator.acquire(
      open(waitingCaller, "waiting", { ...target, id: "emulator-5554", booted: true }, true),
    );
    expect(transferred).toMatchObject({ _tag: "Acquired", shouldBoot: false });
    expect((yield* store.read(first.session.leaseKey))?.owners[0]?.providerSessionId).toBe(
      waitingCaller.providerSessionId,
    );
  }).pipe(Effect.scoped),
);

it.effect("prunes dead FIFO tickets but preserves live waiters past the client deadline", () =>
  Effect.gen(function* () {
    const deadSessionId = ProviderSessionId.make("provider-2");
    const { store, coordinator } = yield* makeRuntime((id) => Effect.succeed(id !== deadSessionId));
    const firstWalk = agent("walk-1", "provider-1");
    const abandoned = agent("walk-2", "provider-2");
    const liveOldWaiter = agent("walk-3", "provider-3");
    const current = agent("walk-4", "provider-4");
    const first = yield* coordinator.acquire(open(firstWalk, "first"));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;
    expect((yield* coordinator.acquire(open(abandoned, "abandoned")))._tag).toBe("Waiting");
    expect((yield* coordinator.acquire(open(liveOldWaiter, "live-old")))._tag).toBe("Waiting");

    const key = deviceLeaseKey(target);
    const record = yield* store.read(key);
    if (!record?.waiters) throw new Error("Expected a persisted waiter.");
    const originalQueuedAt = record.waiters.find(
      (waiter) => waiter.waiterId === "live-old",
    )?.queuedAt;
    if (originalQueuedAt === undefined) throw new Error("Expected the live FIFO waiter.");
    for (let index = 0; index < 3; index++) {
      yield* TestClock.adjust("5 minutes");
      expect((yield* coordinator.acquire(open(liveOldWaiter, "live-old")))._tag).toBe("Waiting");
    }

    expect((yield* coordinator.acquire(open(current, "current")))._tag).toBe("Waiting");
    const updated = yield* store.read(key);
    expect(updated?.waiters?.map((waiter) => waiter.waiterId)).toEqual(["live-old", "current"]);
    expect(updated?.waiters?.[0]?.queuedAt).toBe(originalQueuedAt);
    expect(updated?.waiters?.[0]?.lastPolledAt).toBeGreaterThan(originalQueuedAt);
  }).pipe(Effect.scoped),
);

it.effect("reaps an abandoned request even while its server process is still alive", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime();
    const firstCaller = agent("abandoned-request-1", "provider-abandoned-1");
    const abandoned = agent("abandoned-request-2", "provider-abandoned-2");
    const current = agent("abandoned-request-3", "provider-abandoned-3");
    const first = yield* coordinator.acquire(open(firstCaller, "first"));
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;
    expect((yield* coordinator.acquire(open(abandoned, "abandoned")))._tag).toBe("Waiting");

    const key = deviceLeaseKey(target);
    const record = yield* store.read(key);
    const now = yield* Clock.currentTimeMillis;
    if (!record?.waiters) throw new Error("Expected the abandoned waiter to be persisted.");
    yield* store.write(key, {
      ...record,
      waiters: record.waiters.map((waiter) => {
        if (waiter.waiterId !== "abandoned") return waiter;
        const { lastPolledAt: _lastPolledAt, ...legacyWaiter } = waiter;
        return {
          ...legacyWaiter,
          queuedAt: now - DEVICE_LEASE_WAITER_IDLE_TIMEOUT_MS - 1,
        };
      }),
    });
    expect((yield* coordinator.acquire(open(current, "current")))._tag).toBe("Waiting");
    expect((yield* store.read(key))?.waiters?.map((waiter) => waiter.waiterId)).toEqual([
      "current",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("keeps a fresh waiter when process and provider liveness are unknown", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime(
      () => Effect.succeed(null),
      () => "unknown",
    );
    const first = yield* coordinator.acquire(
      open(agent("unknown-waiter-1", "provider-unknown-1"), "first"),
    );
    expect(first._tag).toBe("Acquired");
    if (first._tag !== "Acquired") return;
    const key = deviceLeaseKey(target);
    const record = yield* store.read(key);
    if (!record) throw new Error("Expected the active lease to be persisted.");
    const now = yield* Clock.currentTimeMillis;
    const foreignProvider = ProviderSessionId.make("provider-unknown-foreign");
    yield* store.write(key, {
      ...record,
      waiters: [
        {
          waiterId: "foreign-unknown",
          threadId: ThreadId.make("foreign-unknown-waiter"),
          kind: "agent",
          providerSessionId: foreignProvider,
          processId: 90,
          processIdentity: "foreign-server-start",
          queuedAt: now,
          lastPolledAt: now,
        },
      ],
    });

    expect(
      (yield* coordinator.acquire(open(agent("unknown-waiter-3", "provider-unknown-3"), "current")))
        ._tag,
    ).toBe("Waiting");
    expect((yield* store.read(key))?.waiters?.map((waiter) => waiter.waiterId)).toEqual([
      "foreign-unknown",
      "current",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("keeps the AVD-name and booted-serial identities on one lease", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime();
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
    expect(releasedByAvdName).toEqual([]);
    expect(yield* store.read(reserved.session.leaseKey)).toMatchObject({
      state: "ready",
      owners: [],
      waiters: [{ waiterId: "contender" }],
      deviceId: "emulator-5554",
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "retains other owners when shutdown is requested and shuts down after the last exact owner",
  () =>
    Effect.gen(function* () {
      const { store, coordinator } = yield* makeRuntime();
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

      const firstRelease = yield* coordinator.release({
        threadId,
        sessionId: firstReady.sessionId,
        leaseId: firstReady.leaseId,
        caller: firstCaller,
        shutdown: true,
      });
      expect(firstRelease).toEqual([]);
      const retained = yield* store.read(first.session.leaseKey);
      expect(retained).toMatchObject({
        state: "ready",
        deviceBooted: true,
        owners: [{ sessionId: second.session.sessionId, leaseId: second.session.leaseId }],
      });

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

it.effect("keeps a booted device for a queued walk when its owner closes with shutdown", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime();
    const firstCaller = agent("shutdown-with-waiter-1", "provider-shutdown-waiter-1");
    const waitingCaller = agent("shutdown-with-waiter-2", "provider-shutdown-waiter-2");
    const reserved = yield* coordinator.acquire(open(firstCaller, "first", target, true));
    expect(reserved._tag).toBe("Acquired");
    if (reserved._tag !== "Acquired") return;
    const ready = yield* coordinator.finishOpen({
      key: reserved.session.leaseKey,
      sessionId: reserved.session.sessionId,
      leaseId: reserved.session.leaseId,
      target: { ...target, id: "emulator-5554", booted: true },
    });
    expect(
      (yield* coordinator.acquire(
        open(waitingCaller, "waiting", {
          ...target,
          id: "emulator-5554",
          booted: true,
        }),
      ))._tag,
    ).toBe("Waiting");

    expect(
      yield* coordinator.release({
        threadId: firstCaller.threadId,
        sessionId: ready.sessionId,
        leaseId: ready.leaseId,
        caller: firstCaller,
        shutdown: true,
      }),
    ).toEqual([]);
    expect(yield* store.read(reserved.session.leaseKey)).toMatchObject({
      state: "ready",
      deviceBooted: true,
      owners: [],
      waiters: [{ waiterId: "waiting" }],
      shutdownOwner: undefined,
    });

    const next = yield* coordinator.acquire(
      open(waitingCaller, "waiting", { ...target, id: "emulator-5554", booted: true }, true),
    );
    expect(next).toMatchObject({ _tag: "Acquired", shouldBoot: false });
  }).pipe(Effect.scoped),
);

it.effect("keeps a booted device for queued walks when an interrupted open is aborted", () =>
  Effect.gen(function* () {
    const { store, coordinator } = yield* makeRuntime();
    const openingCaller = agent("aborted-open-walk-1", "provider-aborted-open-1");
    const waitingCaller = agent("aborted-open-walk-2", "provider-aborted-open-2");
    const reserved = yield* coordinator.acquire(open(openingCaller, "opening", target, true));
    expect(reserved._tag).toBe("Acquired");
    if (reserved._tag !== "Acquired") return;
    expect((yield* coordinator.acquire(open(waitingCaller, "waiting")))._tag).toBe("Waiting");

    const claim = yield* coordinator.abortOpen({
      key: reserved.session.leaseKey,
      sessionId: reserved.session.sessionId,
      leaseId: reserved.session.leaseId,
      target: { ...target, id: "emulator-5554", booted: true },
    });
    expect(claim).toBeUndefined();
    expect(yield* store.read(reserved.session.leaseKey)).toMatchObject({
      state: "ready",
      deviceBooted: true,
      owners: [],
      waiters: [{ waiterId: "waiting" }],
      shutdownOwner: undefined,
    });

    const next = yield* coordinator.acquire(
      open(waitingCaller, "waiting", { ...target, id: "emulator-5554", booted: true }, true),
    );
    expect(next).toMatchObject({ _tag: "Acquired", shouldBoot: false });
  }).pipe(Effect.scoped),
);

it.effect("does not reset another shutdown claim during a stale second open abort", () =>
  Effect.gen(function* () {
    const deadWaiterId = ProviderSessionId.make("provider-dead-shutdown-waiter");
    const liveWaiterId = ProviderSessionId.make("provider-live-shutdown-waiter");
    const { store, coordinator } = yield* makeRuntime((id) => Effect.succeed(id === liveWaiterId));
    const key = deviceLeaseKey(target);
    const claimId = "different-in-progress-claim";
    const record: DeviceLeaseRecord = {
      version: 1,
      leaseId: "lease-being-shut-down",
      state: "shutting_down",
      deviceBooted: true,
      hostId: LOCAL_DEVICE_HOST_ID,
      platform: target.platform,
      canonicalDeviceId: canonicalDeviceId(target),
      deviceId: target.id,
      aliases: [...new Set([target.id, canonicalDeviceId(target), target.name])],
      deviceName: target.name,
      physical: false,
      bootedBySignalbox: true,
      lastDeviceActivityAt: 100,
      owners: [],
      waiters: [
        {
          waiterId: "dead-waiter",
          threadId: ThreadId.make("dead-shutdown-waiter"),
          kind: "agent",
          providerSessionId: deadWaiterId,
          processId: 41,
          processIdentity: "server-start-41",
          queuedAt: 1,
          lastPolledAt: 1,
        },
        {
          waiterId: "live-waiter",
          threadId: ThreadId.make("live-shutdown-waiter"),
          kind: "agent",
          providerSessionId: liveWaiterId,
          processId: 41,
          processIdentity: "server-start-41",
          queuedAt: 2,
          lastPolledAt: 2,
        },
      ],
      shutdownOwner: {
        processId: 90,
        processIdentity: "another-shutdown-worker",
        claimId,
      },
    };
    yield* store.write(key, record);

    expect(
      yield* coordinator.abortOpen({
        key,
        sessionId: "already-removed-owner",
        leaseId: record.leaseId,
        target: { ...target, booted: false },
      }),
    ).toBeUndefined();
    expect(yield* store.read(key)).toEqual(record);

    const waiting = yield* coordinator.acquire(
      open(agent("live-shutdown-waiter", liveWaiterId), "live-waiter", {
        ...target,
        booted: true,
      }),
    );
    expect(waiting._tag).toBe("Waiting");
    expect(yield* store.read(key)).toMatchObject({
      state: "shutting_down",
      deviceBooted: true,
      owners: [],
      waiters: [{ waiterId: "live-waiter" }],
      shutdownOwner: { claimId },
    });
  }).pipe(Effect.scoped),
);

it.effect("does not shut down for an owner whose liveness is unknown", () =>
  Effect.gen(function* () {
    const store = yield* makeMemoryDeviceLeaseStore;
    const access = makeDeviceLeaseAccess({
      store,
      processId: 41,
      processIdentity: "server-start-41",
      isOwnerProcessLive: () => "unknown",
      isProviderSessionLive: () => Effect.succeed(null),
    });
    const coordinator = yield* makeDeviceLeaseCoordinator({ access });
    const threadId = ThreadId.make("unknown-owner-shutdown");
    const panelCaller = { kind: "panel", threadId } as const;
    const agentCaller = agent("unknown-owner-shutdown", "provider-unknown-owner");
    const panel = yield* coordinator.acquire(open(panelCaller, "panel", target, true));
    expect(panel._tag).toBe("Acquired");
    if (panel._tag !== "Acquired") return;
    const ready = yield* coordinator.finishOpen({
      key: panel.session.leaseKey,
      sessionId: panel.session.sessionId,
      leaseId: panel.session.leaseId,
      target: { ...target, id: "emulator-5554", booted: true },
    });
    const agentOwner = yield* coordinator.acquire(
      open(agentCaller, "agent", { ...target, id: "emulator-5554", booted: true }),
    );
    expect(agentOwner._tag).toBe("Acquired");
    if (agentOwner._tag !== "Acquired") return;

    expect(
      yield* coordinator.release({
        threadId,
        sessionId: agentOwner.session.sessionId,
        leaseId: agentOwner.session.leaseId,
        caller: agentCaller,
        shutdown: true,
      }),
    ).toEqual([]);
    expect(yield* store.read(panel.session.leaseKey)).toMatchObject({
      state: "ready",
      deviceBooted: true,
      owners: [{ sessionId: ready.sessionId, leaseId: ready.leaseId }],
      shutdownOwner: undefined,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect("fences a second rollback from clearing a newer shutdown claim on the same lease", () =>
  Effect.gen(function* () {
    const store = yield* makeMemoryDeviceLeaseStore;
    const access = makeDeviceLeaseAccess({
      store,
      processId: 41,
      processIdentity: "server-start-41",
      isOwnerProcessLive: () => "live",
    });
    const coordinator = yield* makeDeviceLeaseCoordinator({ access });
    const janitor = makeDeviceLeaseJanitor(access);
    const caller = agent("claim-generation-walk", "provider-claim-generation");
    const reserved = yield* coordinator.acquire(open(caller, "claim-generation", target, true));
    expect(reserved._tag).toBe("Acquired");
    if (reserved._tag !== "Acquired") return;
    const ready = yield* coordinator.finishOpen({
      key: reserved.session.leaseKey,
      sessionId: reserved.session.sessionId,
      leaseId: reserved.session.leaseId,
      target: { ...target, id: "emulator-5554", booted: true },
    });
    const [firstClaim] = yield* coordinator.release({
      threadId: caller.threadId,
      sessionId: ready.sessionId,
      leaseId: ready.leaseId,
      caller,
      shutdown: true,
    });
    if (!firstClaim) throw new Error("Expected the first shutdown claim.");

    yield* coordinator.finishShutdown(firstClaim, false);
    const secondClaim = yield* janitor.prepareExplicitShutdown({
      target: { ...target, id: "emulator-5554", booted: true },
      leaseId: firstClaim.leaseId,
    });
    expect(secondClaim.leaseId).toBe(firstClaim.leaseId);
    expect(secondClaim.claimId).not.toBe(firstClaim.claimId);

    yield* coordinator.finishShutdown(firstClaim, false);
    expect(yield* store.read(reserved.session.leaseKey)).toMatchObject({
      state: "shutting_down",
      shutdownOwner: { claimId: secondClaim.claimId },
    });
    yield* coordinator.finishShutdown(secondClaim, false);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
