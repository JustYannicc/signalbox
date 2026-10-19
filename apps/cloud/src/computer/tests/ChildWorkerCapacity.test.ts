import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";

describe("ChildWorkerCapacity", () => {
  it("enforces a default maximum of ten positive integer permits", () => {
    expect(new ChildWorkerCapacity().limit).toBe(10);
    expect(new ChildWorkerCapacity(1).limit).toBe(1);
    expect(new ChildWorkerCapacity(10).limit).toBe(10);

    for (const limit of [0, -1, 1.5, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ChildWorkerCapacity(limit)).toThrow(RangeError);
    }
  });

  it("does not admit an eleventh worker while ten are active", async () => {
    const capacity = new ChildWorkerCapacity();
    const permits = await Promise.all(
      Array.from({ length: 10 }, () => capacity.acquire(new AbortController().signal)),
    );
    let admitted = false;
    const eleventh = capacity.acquire(new AbortController().signal).then((permit) => {
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
    const first = await capacity.acquire(signals[0]!);
    const second = await capacity.acquire(signals[1]!);
    const order: number[] = [];
    const thirdPromise = capacity.acquire(signals[2]!).then((permit) => {
      order.push(3);
      return permit;
    });
    const fourthPromise = capacity.acquire(signals[3]!).then((permit) => {
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
    await expect(capacity.acquire(alreadyAborted.signal)).rejects.toBe(reason);
    expect(capacity.active).toBe(0);

    const held = await capacity.acquire(new AbortController().signal);
    const cancelled = new AbortController();
    const cancelledWaiter = capacity.acquire(cancelled.signal);
    const nextWaiter = capacity.acquire(new AbortController().signal);
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
    const permit = await capacity.acquire(controller.signal);

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

    await expect(capacity.acquire(signal)).rejects.toBe(reason);
    expect(capacity.active).toBe(0);
    const permit = await capacity.acquire(new AbortController().signal);
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

    const permit = await capacity.acquire(signal);
    expect(capacity.active).toBe(1);
    permit.release();
    expect(capacity.active).toBe(0);
  });

  it("releases capacity in run when finite work rejects", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const reason = new Error("child failed");
    const held = await capacity.acquire(new AbortController().signal);
    const work = capacity.run(new AbortController().signal, async () => {
      throw reason;
    });

    held.release();
    await expect(work).rejects.toBe(reason);
    expect(capacity.active).toBe(0);
  });
});
