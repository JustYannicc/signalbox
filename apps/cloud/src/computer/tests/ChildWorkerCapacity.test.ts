import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";

const fixtures: ReturnType<typeof childBusyboxFixture>[] = [];
function requester() {
  const fixture = childBusyboxFixture();
  fixtures.push(fixture);
  return { processes: fixture.context.processes, process: fixture.context.identity.handle };
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("ChildWorkerCapacity", () => {
  it("runs limit plus five root commands FIFO within the soft limit", async () => {
    const capacity = new ChildWorkerCapacity();
    const signal = new AbortController().signal;
    const full = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const order: number[] = [];
    let maximum = 0;
    const commands = Array.from({ length: capacity.limit + 5 }, (_, index) =>
      capacity.run(
        signal,
        async () => {
          order.push(index);
          maximum = Math.max(maximum, capacity.active);
          if (order.length === capacity.limit) full.resolve();
          await finish.promise;
          return index * index;
        },
        requester(),
      ),
    );
    await full.promise;
    expect(order).toEqual(Array.from({ length: capacity.limit }, (_, index) => index));
    finish.resolve();
    expect(await Promise.all(commands)).toEqual(
      Array.from({ length: capacity.limit + 5 }, (_, index) => index * index),
    );
    expect(order).toEqual(Array.from({ length: capacity.limit + 5 }, (_, index) => index));
    expect(maximum).toBe(capacity.limit);
    expect(capacity.active).toBe(0);
  });

  it("skips ownership lookups and queue listeners when the soft pool has room", async () => {
    const capacity = new ChildWorkerCapacity();
    const signal = new AbortController().signal;
    const wakes = new KernelWakeRegistry();
    const processes = new KernelProcessTable({ wakes });
    const owner = vi.spyOn(processes, "admissionOwner");
    const listen = vi.spyOn(signal, "addEventListener");
    try {
      const permit = await capacity.acquire(signal, { processes, process: undefined });
      expect(owner).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      permit.release();
    } finally {
      await processes.dispose();
      wakes.dispose();
    }
  });

  it("validates the soft and hard limits", () => {
    expect(new ChildWorkerCapacity().limit).toBe(10);
    expect(new ChildWorkerCapacity(1).limit).toBe(1);
    expect(new ChildWorkerCapacity(10).limit).toBe(10);

    expect(new ChildWorkerCapacity().hardLimit).toBe(64);
    expect(new ChildWorkerCapacity(11).limit).toBe(11);
    expect(new ChildWorkerCapacity(65).hardLimit).toBe(65);
    for (const hardLimit of [0, -1, 1.5, 9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ChildWorkerCapacity(10, { hardLimit })).toThrow(RangeError);
    }
    expect(new ChildWorkerCapacity(10, { hardLimit: 10 }).hardLimit).toBe(10);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ChildWorkerCapacity(limit)).toThrow(RangeError);
    }
  });

  it("does not admit an eleventh worker while ten are active", async () => {
    const capacity = new ChildWorkerCapacity();
    const permits = await Promise.all(
      Array.from({ length: 10 }, () => capacity.acquire(new AbortController().signal, undefined)),
    );
    let admitted = false;
    const eleventh = capacity.acquire(new AbortController().signal, undefined).then((permit) => {
      admitted = true;
      return permit;
    });

    expect(capacity.active).toBe(10);
    expect(admitted).toBe(false);
    permits[0]!.release();
    const next = await eleventh;
    expect(capacity.active).toBe(10);
    permits.slice(1).forEach((permit) => permit.release());
    next.release();
    expect(capacity.active).toBe(0);
  });

  it("keeps the active count within the limit and admits queued work in FIFO order", async () => {
    const capacity = new ChildWorkerCapacity(2);
    const signals = Array.from({ length: 4 }, () => new AbortController().signal);
    const first = await capacity.acquire(signals[0]!, undefined);
    const second = await capacity.acquire(signals[1]!, undefined);
    const order: number[] = [];
    const thirdPromise = capacity.acquire(signals[2]!, undefined).then((permit) => {
      order.push(3);
      return permit;
    });
    const fourthPromise = capacity.acquire(signals[3]!, undefined).then((permit) => {
      order.push(4);
      return permit;
    });

    expect(capacity.active).toBe(2);
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual([3]);
    expect(capacity.active).toBe(2);

    first.release();
    const fourth = await fourthPromise;
    expect(order).toEqual([3, 4]);
    expect(capacity.active).toBe(2);

    third.release();
    fourth.release();
    expect(capacity.active).toBe(0);
  });

  it("rejects pre-aborted and queued waiters, then admits the next waiter", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const reason = new Error("cancelled");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(reason);
    await expect(capacity.acquire(alreadyAborted.signal, undefined)).rejects.toBe(reason);
    expect(capacity.active).toBe(0);

    const held = await capacity.acquire(new AbortController().signal, undefined);
    const cancelled = new AbortController();
    const cancelledWaiter = capacity.acquire(cancelled.signal, undefined);
    const nextWaiter = capacity.acquire(new AbortController().signal, undefined);
    cancelled.abort(reason);

    await expect(cancelledWaiter).rejects.toBe(reason);
    held.release();
    const next = await nextWaiter;
    expect(capacity.active).toBe(1);
    next.release();
    expect(capacity.active).toBe(0);
  });

  it("does not release a granted permit when its signal aborts", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const controller = new AbortController();
    const permit = await capacity.acquire(controller.signal, undefined);

    controller.abort();
    expect(capacity.active).toBe(1);
    permit.release();
    permit.release();
    expect(capacity.active).toBe(0);
  });

  it("remains safe when a signal aborts reentrantly during listener installation", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const controller = new AbortController();
    const reason = new Error("cancelled during admission");
    const nativeSignal = controller.signal;
    const signal = {
      get aborted() {
        return nativeSignal.aborted;
      },
      get reason() {
        return nativeSignal.reason;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        nativeSignal.addEventListener(type, listener, options);
        controller.abort(reason);
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        nativeSignal.removeEventListener(type, listener, options);
      },
    } as unknown as AbortSignal;

    const held = await capacity.acquire(new AbortController().signal, undefined);
    await expect(capacity.acquire(signal, undefined)).rejects.toBe(reason);
    expect(capacity.active).toBe(1);
    held.release();
    const permit = await capacity.acquire(new AbortController().signal, undefined);
    expect(capacity.active).toBe(1);
    permit.release();
  });

  it("keeps an admitted permit active when abort fires while the listener is removed", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const controller = new AbortController();
    const nativeSignal = controller.signal;
    const signal = {
      get aborted() {
        return nativeSignal.aborted;
      },
      get reason() {
        return nativeSignal.reason;
      },
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        nativeSignal.addEventListener(type, listener, options);
      },
      removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        controller.abort(new Error("cancelled after grant"));
        nativeSignal.removeEventListener(type, listener, options);
      },
    } as unknown as AbortSignal;

    const held = await capacity.acquire(new AbortController().signal, undefined);
    const pending = capacity.acquire(signal, undefined);
    held.release();
    const permit = await pending;
    expect(controller.signal.aborted).toBe(true);
    expect(capacity.active).toBe(1);
    permit.release();
    expect(capacity.active).toBe(0);
  });

  it("releases capacity in run when finite work rejects", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const reason = new Error("child failed");
    await expect(
      capacity.run(
        new AbortController().signal,
        async () => {
          throw reason;
        },
        requester(),
      ),
    ).rejects.toBe(reason);
    expect(capacity.active).toBe(0);
  });
});
