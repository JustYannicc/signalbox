import { afterEach, describe, expect, it } from "vite-plus/test";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";
import { ChildWorkerCapacity, isChildWorkerReservation } from "../ChildWorkerCapacity.ts";
import {
  validateProcessSlotCodeId,
  validateProcessSlotOwner,
  type ProcessSlots,
} from "../ProcessSlots.ts";

const fixtures: ReturnType<typeof childBusyboxFixture>[] = [];
function requester() {
  const fixture = childBusyboxFixture();
  fixtures.push(fixture);
  return { processes: fixture.context.processes, process: fixture.context.identity.handle };
}
function request(codeId: string, residentBytes = 0) {
  return Object.freeze({ codeId, residentBytes });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}
function manualQuantum() {
  const tasks: { callback: () => void; cancelled: boolean }[] = [];
  return {
    scheduleQuantum(callback: () => void) {
      const task = { callback, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    fireNext() {
      const task = tasks.find((candidate) => !candidate.cancelled);
      if (task === undefined) throw new Error("No scheduled quantum");
      task.cancelled = true;
      task.callback();
    },
    get pending() {
      return tasks.filter((task) => !task.cancelled).length;
    },
  };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("ChildWorkerCapacity", () => {
  it("holds the strict limit and admits queued roots FIFO without a nested burst", async () => {
    const capacity = new ChildWorkerCapacity(2, {
      owner: "test/src-computer-tests-childworkercapacity-test-1",
    });
    const requests = [request("one"), request("two"), request("three"), request("four")];
    const first = await capacity.acquire(new AbortController().signal, undefined, requests[0]);
    const second = await capacity.acquire(new AbortController().signal, undefined, requests[1]);
    const order: string[] = [];
    const thirdPromise = capacity
      .acquire(new AbortController().signal, undefined, requests[2])
      .then((permit) => {
        order.push("three");
        return permit;
      });
    const fourthPromise = capacity
      .acquire(new AbortController().signal, undefined, requests[3])
      .then((permit) => {
        order.push("four");
        return permit;
      });

    expect(capacity.active).toBe(2);
    await second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["three"]);
    expect(capacity.active).toBe(2);
    await first.release();
    const fourth = await fourthPromise;
    expect(order).toEqual(["three", "four"]);
    await Promise.all([third.release(), fourth.release()]);
    expect(capacity.active).toBe(0);
  });

  it("uses distinct lease IDs concurrently, then warm reuses an acknowledged slot", async () => {
    const capacity = new ChildWorkerCapacity(2, {
      owner: "test/src-computer-tests-childworkercapacity-test-2",
    });
    const code = request("warm-code");
    const first = await capacity.acquire(new AbortController().signal, undefined, code);
    const second = await capacity.acquire(new AbortController().signal, undefined, code);
    expect(first.execution.loaderId).not.toBe(second.execution.loaderId);
    const firstId = first.execution.loaderId;

    await first.release();
    const reused = await capacity.acquire(new AbortController().signal, undefined, code);
    expect(reused.execution.loaderId).toBe(firstId);
    await Promise.all([second.release(), reused.release()]);
  });

  it("retires a lost slot generation before reusing its code ID", async () => {
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-childworkercapacity-test-3",
    });
    const code = request("lost-code");
    const first = await capacity.acquire(new AbortController().signal, undefined, code);
    const oldId = first.execution.loaderId;
    await first.execution.lose("memory");
    await first.release();

    const next = await capacity.acquire(new AbortController().signal, undefined, code);
    expect(next.execution.loaderId).not.toBe(oldId);
    await next.release();
  });

  it("keeps nested waiters ahead of queued roots without exceeding the limit", async () => {
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-childworkercapacity-test-4",
    });
    const parent = requester();
    const done = deferred<void>();
    const started = deferred<void>();
    const parentRun = capacity.run(
      new AbortController().signal,
      async () => {
        started.resolve(undefined);
        await done.promise;
      },
      parent,
      request("parent"),
    );
    await started.promise;

    const root = capacity.acquire(new AbortController().signal, undefined, request("root"));
    const nested = capacity.acquire(new AbortController().signal, parent, request("nested"));
    done.resolve(undefined);

    const child = await nested;
    expect(child.execution.lease.codeId).toBe("nested");
    expect(capacity.active).toBe(1);
    await child.release();
    const rootPermit = await root;
    expect(rootPermit.execution.lease.codeId).toBe("root");
    await rootPermit.release();
    await parentRun;
  });

  it("reports queued-root capacity pressure each quantum and stops after abort", async () => {
    const quantum = manualQuantum();
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/capacity-pressure-quantum",
      scheduleQuantum: quantum.scheduleQuantum,
    });
    const held = await capacity.acquire(new AbortController().signal, undefined, request("held"));
    const controller = new AbortController();
    const pressures: { kind: string; inFlight: number; waiting: number }[] = [];
    const unsubscribe = capacity.onPressure((pressure) => pressures.push(pressure));
    const queued = capacity.acquire(controller.signal, undefined, request("queued"));
    const outcome = queued.then(
      () => "admitted" as const,
      () => "rejected" as const,
    );

    expect(capacity.waiting).toBe(1);
    expect(quantum.pending).toBe(1);
    quantum.fireNext();
    expect(pressures).toEqual([{ kind: "capacity", inFlight: 1, resident: 1, waiting: 1 }]);
    expect(quantum.pending).toBe(1);
    expect(await Promise.race([outcome, Promise.resolve("pending" as const)])).toBe("pending");
    quantum.fireNext();
    expect(pressures).toHaveLength(2);
    expect(quantum.pending).toBe(1);

    controller.abort(new Error("cancel queued root"));
    await expect(queued).rejects.toThrow("cancel queued root");
    expect(capacity.waiting).toBe(0);
    expect(quantum.pending).toBe(0);
    await held.release();
    expect(pressures).toHaveLength(2);
    unsubscribe();
  });

  it("cancels queued-root pressure when the active slot drains", async () => {
    const quantum = manualQuantum();
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/capacity-pressure-drain",
      scheduleQuantum: quantum.scheduleQuantum,
    });
    const held = await capacity.acquire(new AbortController().signal, undefined, request("held"));
    const pressures: string[] = [];
    const unsubscribe = capacity.onPressure((pressure) => pressures.push(pressure.kind));
    const queued = capacity.acquire(new AbortController().signal, undefined, request("queued"));

    quantum.fireNext();
    expect(pressures).toEqual(["capacity"]);
    const nextQuantumPending = quantum.pending;
    expect(nextQuantumPending).toBe(1);

    await held.release();
    const admitted = await queued;
    expect(quantum.pending).toBe(0);
    expect(pressures).toEqual(["capacity"]);
    await admitted.release();
    unsubscribe();
  });

  it("sends unplaceable requests to pressure without blocking a fitting acquire", async () => {
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-childworkercapacity-test-5",
    });
    const pressured = deferred<void>();
    const unsubscribe = capacity.onPressure((pressure) => {
      if (pressure.kind === "unplaceable" && "request" in pressure) {
        pressured.resolve(undefined);
      }
    });
    const controller = new AbortController();
    const unplaceable = capacity.acquire(
      controller.signal,
      undefined,
      request("too-large", capacity.residentByteLimit + 1),
    );
    const rejected = unplaceable.then(
      () => new Error("unexpected admission"),
      (error: unknown) => error,
    );
    await pressured.promise;

    const fitting = await capacity.acquire(
      new AbortController().signal,
      undefined,
      request("fits"),
    );
    expect(fitting.execution.lease.codeId).toBe("fits");
    controller.abort(new Error("test cleanup"));
    await rejected;
    await fitting.release();
    unsubscribe();
  });

  it("preserves the exact prepared object on an opaque one-use reservation", async () => {
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/capacity-prepared-request",
      residentByteLimit: 4096,
    });
    const code = request("prepared");
    const reservation = await capacity.reserve(new AbortController().signal, requester(), code);
    expect(isChildWorkerReservation(reservation)).toBe(true);
    expect(reservation.request).toBe(code);
    const started = deferred<void>();
    const finished = deferred<void>();
    const running = reservation.run(
      new AbortController().signal,
      async (execution) => {
        expect(execution.loaderId).toBe(execution.lease.loaderId);
        expect(execution.residentByteLimit).toBe(4096);
        started.resolve(undefined);
        await finished.promise;
      },
      requester(),
      code,
    );
    await started.promise;
    await expect(
      reservation.run(new AbortController().signal, async () => {}, requester(), code),
    ).rejects.toThrow("no longer available");
    finished.resolve(undefined);
    await running;
    expect(capacity.active).toBe(0);
  });

  it("requires an explicit positive in-flight limit", () => {
    expect(
      new ChildWorkerCapacity(4, { owner: "test/src-computer-tests-childworkercapacity-test-6" })
        .limit,
    ).toBe(4);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new ChildWorkerCapacity(limit, {
            owner: "test/src-computer-tests-childworkercapacity-test-7",
          }),
      ).toThrow(RangeError);
    }
  });

  it("exports and applies the process-slot identity validators", () => {
    expect(() => validateProcessSlotOwner("thread/shard-1")).not.toThrow();
    expect(() => validateProcessSlotCodeId("worker-code")).not.toThrow();
    expect(() => validateProcessSlotOwner("shard-only")).toThrow(TypeError);
    expect(() => validateProcessSlotCodeId("bad/code")).toThrow(TypeError);
    expect(() => new ChildWorkerCapacity(1, { owner: "shard-only" })).toThrow(TypeError);
  });

  it("returns acquire validation failures through its promise and rejects mismatched slot limits", async () => {
    const capacity = new ChildWorkerCapacity(1, { owner: "test/capacity-preconditions" });
    const invalidCode = Object.freeze({ codeId: "bad/code", residentBytes: 0 });
    await expect(
      capacity.acquire(new AbortController().signal, undefined, invalidCode),
    ).rejects.toThrow(TypeError);

    const mismatched = new ChildWorkerCapacity(1, {
      owner: "test/capacity-slot-limit",
      slots: { inFlightLimit: 2 } as ProcessSlots,
    });
    await expect(
      mismatched.acquire(new AbortController().signal, undefined, request("valid")),
    ).rejects.toThrow("must use the capacity limit");
  });
});
