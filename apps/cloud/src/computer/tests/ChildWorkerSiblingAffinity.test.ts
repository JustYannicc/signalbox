import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelProgramAdmissionRequest } from "../../kernel/KernelProgramAdmission.ts";
import type { KernelProcessIdentity } from "../../kernel/KernelProcessTable.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import type {
  ProcessSlotLease,
  ProcessSlotPermit,
  ProcessSlotPressure,
  ProcessSlotRequest,
  ProcessSlots,
} from "../ProcessSlots.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createComputerProgramAdmission } from "../ComputerProgramAdmission.ts";
import { ComputerEscalationTable } from "../EscalationTable.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";
import { machinePort, prepared, requestFor } from "./ComputerProgramAdmissionTestSupport.ts";

function processTree() {
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const completion = Promise.withResolvers<{
    exitCode: number;
    signal: number;
    coreDumped: boolean;
  }>();
  return {
    processes,
    spawn(parent?: KernelProcessIdentity) {
      const result = processes.spawn(
        parent?.handle,
        () => ({
          completion: completion.promise,
          signal: () => ({ status: "ok", value: undefined }),
        }),
        () => {},
      );
      if (result.status !== "ok") throw new Error("Test process could not start");
      return result.value;
    },
    async close() {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await processes.dispose();
      wakes.dispose();
    },
  };
}

function startGatedRun(
  capacity: ChildWorkerCapacity,
  processes: KernelProcessTable,
  identity: KernelProcessIdentity,
  codeId: string,
  order: string[],
) {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const promise = capacity.run(
    new AbortController().signal,
    async () => {
      order.push(codeId);
      started.resolve();
      await finish.promise;
      return codeId;
    },
    { processes, process: identity.handle },
    Object.freeze({ codeId, residentBytes: 0 }),
  );
  void promise.catch(() => undefined);
  return { started: started.promise, finish: () => finish.resolve(), promise };
}

function controlledProcessSlots(limit: number, delayedCodeId: string) {
  type Acquisition = { lease: ProcessSlotLease; permit: ProcessSlotPermit };
  const requests: string[] = [];
  const started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Acquisition>>>();
  const failures = new Map<string, unknown>();
  let nextToken = 1;
  const result = (codeId: string, residentBytes: number): Acquisition => {
    const token = `sibling-affinity-${nextToken++}` as ProcessSlotLease["token"];
    return {
      lease: { token, loaderId: `loader-${nextToken}`, codeId, residentBytes },
      permit: { token },
    };
  };
  const slots = {
    inFlightLimit: limit,
    acquire(request: ProcessSlotRequest) {
      requests.push(request.codeId);
      started.get(request.codeId)?.resolve();
      if (failures.has(request.codeId)) {
        const failure = failures.get(request.codeId);
        failures.delete(request.codeId);
        return Promise.reject(failure);
      }
      if (request.codeId === delayedCodeId) {
        const acquisition = Promise.withResolvers<Acquisition>();
        pending.set(request.codeId, acquisition);
        return acquisition.promise;
      }
      return Promise.resolve(result(request.codeId, request.residentBytes));
    },
    async park<T>(
      _lease: ProcessSlotLease,
      permit: ProcessSlotPermit,
      waitFor: () => Promise<T>,
      _signal: AbortSignal,
    ) {
      return { value: await waitFor(), permit };
    },
    async handoff(_lease: ProcessSlotLease, _stopped: { readonly acknowledged: true }) {},
    observe(_lease: ProcessSlotLease, _residentBytes: number) {},
    async release(_lease: ProcessSlotLease, _stopped: { readonly acknowledged: true }) {},
    async lose(_lease: ProcessSlotLease, _reason: "memory" | "isolate") {},
    signals: {
      inFlight: 0,
      resident: 0,
      waiting: 0,
      lost: 0,
      fenced: false,
      onFenced: (_listener: (error: unknown) => void) => () => {},
      onPressure: (_listener: (pressure: ProcessSlotPressure) => void) => () => {},
    },
  } satisfies ProcessSlots;
  return {
    slots,
    requests,
    started,
    pending,
    fail(codeId: string, failure: unknown) {
      failures.set(codeId, failure);
    },
    watch(codeId: string) {
      const event = Promise.withResolvers<void>();
      started.set(codeId, event);
      return event.promise;
    },
    resolve(codeId: string) {
      const acquisition = pending.get(codeId);
      if (acquisition === undefined) return;
      pending.delete(codeId);
      acquisition.resolve(result(codeId, 0));
    },
  };
}

describe("ChildWorkerCapacity sibling affinity", () => {
  it("admits a later sibling ahead of an earlier unrelated waiter", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(2, { owner: "test/sibling-affinity-priority" });
    const familyA = tree.spawn();
    const activeChildA = tree.spawn(familyA);
    const siblingA = tree.spawn(familyA);
    const familyB = tree.spawn();
    const unrelatedWaiterB = tree.spawn(familyB);
    const otherFamily = tree.spawn();
    const otherHeldSlot = tree.spawn(otherFamily);
    const order: string[] = [];
    const runs = [
      startGatedRun(capacity, tree.processes, activeChildA, "active-child-a", order),
      startGatedRun(capacity, tree.processes, otherHeldSlot, "other-held-slot", order),
    ];

    try {
      await Promise.all(runs.map((run) => run.started));
      const unrelated = startGatedRun(
        capacity,
        tree.processes,
        unrelatedWaiterB,
        "unrelated-waiter-b",
        order,
      );
      const sibling = startGatedRun(capacity, tree.processes, siblingA, "sibling-a", order);
      runs.push(unrelated, sibling);
      expect(capacity.active).toBe(2);
      expect(capacity.waiting).toBe(2);

      runs[1]!.finish();
      await runs[1]!.promise;
      const firstAdmitted = await Promise.race([
        unrelated.started.then(() => "unrelated-waiter-b"),
        sibling.started.then(() => "sibling-a"),
      ]);

      expect(firstAdmitted).toBe("sibling-a");
      expect(order).toEqual(["active-child-a", "other-held-slot", "sibling-a"]);
      expect(capacity.active).toBe(2);
      expect(capacity.waiting).toBe(1);
    } finally {
      for (const run of runs) run.finish();
      await Promise.allSettled(runs.map((run) => run.promise));
      await tree.close();
    }
  });

  it("keeps FIFO order when no queued family has an active child", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1, { owner: "test/sibling-affinity-fifo" });
    const holder = tree.spawn(tree.spawn());
    const first = tree.spawn(tree.spawn());
    const second = tree.spawn(tree.spawn());
    const order: string[] = [];
    const runs = [startGatedRun(capacity, tree.processes, holder, "holder", order)];

    try {
      await runs[0]!.started;
      const firstRun = startGatedRun(capacity, tree.processes, first, "first", order);
      const secondRun = startGatedRun(capacity, tree.processes, second, "second", order);
      runs.push(firstRun, secondRun);
      runs[0]!.finish();
      await runs[0]!.promise;
      const firstAdmitted = await Promise.race([
        firstRun.started.then(() => "first"),
        secondRun.started.then(() => "second"),
      ]);

      expect(firstAdmitted).toBe("first");
      expect(order).toEqual(["holder", "first"]);
      expect(capacity.waiting).toBe(1);
    } finally {
      for (const run of runs) run.finish();
      await Promise.allSettled(runs.map((run) => run.promise));
      await tree.close();
    }
  });

  it("does not match a same-PID family from another process table", async () => {
    const activeTree = processTree();
    const unrelatedTree = processTree();
    const capacity = new ChildWorkerCapacity(2, { owner: "test/sibling-affinity-table-key" });
    const activeParent = activeTree.spawn();
    const activeChild = activeTree.spawn(activeParent);
    const unrelatedParent = activeTree.spawn();
    const unrelatedWaiter = activeTree.spawn(unrelatedParent);
    const samePidParent = unrelatedTree.spawn();
    const samePidWaiter = unrelatedTree.spawn(samePidParent);
    const otherFamily = activeTree.spawn();
    const otherHeldSlot = activeTree.spawn(otherFamily);
    const order: string[] = [];
    const runs = [
      startGatedRun(capacity, activeTree.processes, activeChild, "active-child", order),
      startGatedRun(capacity, activeTree.processes, otherHeldSlot, "other-held-slot", order),
    ];

    try {
      expect(samePidParent.pid).toBe(activeParent.pid);
      await Promise.all(runs.map((run) => run.started));
      const unrelated = startGatedRun(
        capacity,
        activeTree.processes,
        unrelatedWaiter,
        "unrelated-waiter",
        order,
      );
      const samePid = startGatedRun(
        capacity,
        unrelatedTree.processes,
        samePidWaiter,
        "same-pid-other-table",
        order,
      );
      runs.push(unrelated, samePid);

      runs[1]!.finish();
      await runs[1]!.promise;
      const firstAdmitted = await Promise.race([
        unrelated.started.then(() => "unrelated-waiter"),
        samePid.started.then(() => "same-pid-other-table"),
      ]);

      expect(firstAdmitted).toBe("unrelated-waiter");
      expect(order).toEqual(["active-child", "other-held-slot", "unrelated-waiter"]);
    } finally {
      for (const run of runs) run.finish();
      await Promise.allSettled(runs.map((run) => run.promise));
      await activeTree.close();
      await unrelatedTree.close();
    }
  });

  it("counts a sibling at slot submission before acquire resolves or binds", async () => {
    const tree = processTree();
    const underlying = controlledProcessSlots(2, "sibling-a-one");
    const capacity = new ChildWorkerCapacity(2, {
      owner: "test/sibling-affinity-submitted",
      slots: underlying.slots,
    });
    const familyA = tree.spawn();
    const activeChildA = tree.spawn(familyA);
    const siblingAOne = tree.spawn(familyA);
    const siblingATwo = tree.spawn(familyA);
    const familyB = tree.spawn();
    const unrelatedWaiterB = tree.spawn(familyB);
    const otherFamily = tree.spawn();
    const otherHeldSlot = tree.spawn(otherFamily);
    const order: string[] = [];
    const activeCode = "active-child-a";
    const otherCode = "other-held-slot";
    const firstSiblingCode = "sibling-a-one";
    const secondSiblingCode = "sibling-a-two";
    const unrelatedCode = "unrelated-waiter-b";
    const activeStarted = underlying.watch(activeCode);
    const otherStarted = underlying.watch(otherCode);
    const firstSiblingStarted = underlying.watch(firstSiblingCode);
    const secondSiblingStarted = underlying.watch(secondSiblingCode);
    const unrelatedStarted = underlying.watch(unrelatedCode);
    const runs = [
      startGatedRun(capacity, tree.processes, activeChildA, activeCode, order),
      startGatedRun(capacity, tree.processes, otherHeldSlot, otherCode, order),
    ];

    try {
      await Promise.all([activeStarted, otherStarted]);
      await Promise.all(runs.map((run) => run.started));
      const unrelated = startGatedRun(
        capacity,
        tree.processes,
        unrelatedWaiterB,
        unrelatedCode,
        order,
      );
      const firstSibling = startGatedRun(
        capacity,
        tree.processes,
        siblingAOne,
        firstSiblingCode,
        order,
      );
      const secondSibling = startGatedRun(
        capacity,
        tree.processes,
        siblingATwo,
        secondSiblingCode,
        order,
      );
      runs.push(unrelated, firstSibling, secondSibling);

      runs[1]!.finish();
      runs[0]!.finish();
      await Promise.all([runs[0]!.promise, runs[1]!.promise]);
      await firstSiblingStarted;
      expect(
        await Promise.race([
          secondSiblingStarted.then(() => secondSiblingCode),
          unrelatedStarted.then(() => unrelatedCode),
        ]),
      ).toBe(secondSiblingCode);
      expect(underlying.requests).toEqual([
        activeCode,
        otherCode,
        firstSiblingCode,
        secondSiblingCode,
      ]);

      underlying.resolve(firstSiblingCode);
      await Promise.all([firstSibling.started, secondSibling.started]);
      expect(order).toEqual([activeCode, otherCode, secondSiblingCode, firstSiblingCode]);

      firstSibling.finish();
      await firstSibling.promise;
      await unrelatedStarted;
      await unrelated.started;
      expect(order).toContain(unrelatedCode);
    } finally {
      underlying.resolve(firstSiblingCode);
      for (const run of runs) run.finish();
      await Promise.allSettled(runs.map((run) => run.promise));
      await tree.close();
    }
  });

  it("removes failed submissions from their family before the next admission", async () => {
    const tree = processTree();
    const underlying = controlledProcessSlots(2, "never-delayed");
    const capacity = new ChildWorkerCapacity(2, {
      owner: "test/sibling-affinity-acquire-failure",
      slots: underlying.slots,
    });
    const failure = new Error("slot acquire failed");
    const familyA = tree.spawn();
    const activeChildA = tree.spawn(familyA);
    const failedSiblingA = tree.spawn(familyA);
    const laterSiblingA = tree.spawn(familyA);
    const familyB = tree.spawn();
    const unrelatedWaiterB = tree.spawn(familyB);
    const familyC = tree.spawn();
    const laterUnrelatedC = tree.spawn(familyC);
    const otherFamily = tree.spawn();
    const otherHeldSlot = tree.spawn(otherFamily);
    const order: string[] = [];
    const activeCode = "active-child-a";
    const otherCode = "other-held-slot";
    const failedCode = "failed-sibling-a";
    const unrelatedCode = "unrelated-waiter-b";
    const laterUnrelatedCode = "later-unrelated-c";
    const laterSiblingCode = "later-sibling-a";
    const activeStarted = underlying.watch(activeCode);
    const otherStarted = underlying.watch(otherCode);
    const unrelatedStarted = underlying.watch(unrelatedCode);
    underlying.fail(failedCode, failure);
    const runs = [
      startGatedRun(capacity, tree.processes, activeChildA, activeCode, order),
      startGatedRun(capacity, tree.processes, otherHeldSlot, otherCode, order),
    ];

    try {
      await Promise.all([activeStarted, otherStarted]);
      await Promise.all(runs.map((run) => run.started));
      const failedSibling = startGatedRun(
        capacity,
        tree.processes,
        failedSiblingA,
        failedCode,
        order,
      );
      const unrelated = startGatedRun(
        capacity,
        tree.processes,
        unrelatedWaiterB,
        unrelatedCode,
        order,
      );
      runs.push(failedSibling, unrelated);

      runs[1]!.finish();
      await runs[1]!.promise;
      await expect(failedSibling.promise).rejects.toBe(failure);
      await unrelatedStarted;
      await unrelated.started;
      expect(capacity.active).toBe(2);

      const laterUnrelated = startGatedRun(
        capacity,
        tree.processes,
        laterUnrelatedC,
        laterUnrelatedCode,
        order,
      );
      const laterSibling = startGatedRun(
        capacity,
        tree.processes,
        laterSiblingA,
        laterSiblingCode,
        order,
      );
      runs.push(laterUnrelated, laterSibling);

      runs[0]!.finish();
      await runs[0]!.promise;
      const firstAfterFailure = await Promise.race([
        laterUnrelated.started.then(() => laterUnrelatedCode),
        laterSibling.started.then(() => laterSiblingCode),
      ]);

      expect(firstAfterFailure).toBe(laterUnrelatedCode);
      expect(order).toContain(laterUnrelatedCode);
    } finally {
      for (const run of runs) run.finish();
      await Promise.allSettled(runs.map((run) => run.promise));
      await tree.close();
    }
  });

  it.each(["exec", "spawn", "command"] as const)(
    "uses the real kernel parent PID for a %s admission",
    async (kind) => {
      const fixture = childBusyboxFixture();
      const capacity = new ChildWorkerCapacity(1, {
        owner: `test/sibling-affinity-computer-${kind}`,
      });
      const implementation = {
        kind: "async" as const,
        prepare: async () => prepared(),
        run: async () => exited(),
      };
      const admission = createComputerProgramAdmission({
        capacity,
        escalation: new ComputerEscalationTable(),
        machine: machinePort(),
      });
      const enqueue = vi.spyOn(capacity, "enqueue");
      const base = requestFor(fixture.context, implementation);
      let request: KernelProgramAdmissionRequest;
      if (kind === "exec") {
        request = base;
      } else if (kind === "spawn") {
        request = Object.freeze({
          ...base,
          kind,
          parent: fixture.context.identity.handle,
        });
      } else {
        request = Object.freeze({
          ...base,
          kind,
          parent: fixture.context.identity.handle,
          stdio: "piped",
        });
      }

      try {
        const expectedParent = fixture.context.processes.info(fixture.context.identity.handle);
        if (expectedParent.status !== "ok") throw new Error("Test parent process is unavailable");
        const expectedParentPid =
          kind === "exec" ? expectedParent.value.parentPid : expectedParent.value.pid;
        const decision = await admission.admit(request);

        expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ parentPid: expectedParentPid });
        decision.cancel?.();
        expect(capacity.active).toBe(0);
      } finally {
        admission.close();
        await fixture.close();
      }
    },
  );
});
