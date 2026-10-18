import { describe, expect, it } from "vite-plus/test";
import type { ClientActionTiming } from "@t3tools/contracts/clientActionTiming";
import { createActionTimingQueue } from "@t3tools/client-runtime/observability/action-timing-queue";

function sample(index: number): ClientActionTiming {
  return {
    action: "thread.send",
    entryPoint: "click",
    client: "web",
    os: "linux",
    device: "computer",
    release: "development",
    connection: "online",
    mode: "cloud",
    path: "optimistic",
    inputTimeMs: index,
    handlerDelayMs: 0,
    feedback: null,
    desiredState: null,
    eventTimingMs: null,
    eventTimingMethod: null,
    eventTimingStatus: "unavailable",
    acknowledgementMs: null,
    convergenceMs: null,
    completionMs: null,
    outcome: "success",
    correlationId: `${(index + 1).toString(16).padStart(32, "0")}`,
  };
}

function scheduler() {
  const jobs: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];

  return {
    jobs,
    schedule: (callback: () => void, delayMs: number) => {
      const job = { callback, delayMs, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("action timing queue", () => {
  it("yields to its timer when new samples arrive during export", async () => {
    const timers = scheduler();
    const started = deferred();
    const release = deferred();
    const batches: ReadonlyArray<ClientActionTiming>[] = [];
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      enabled: () => true,
      send: async (batch) => {
        batches.push(batch);
        started.resolve();
        await release.promise;
      },
    });
    queue.enqueue(sample(0));
    const flushing = queue.flush();
    await started.promise;
    queue.enqueue(sample(1));
    release.resolve();
    await flushing;
    expect(batches).toEqual([[sample(0)]]);
    expect(queue.stats().queued).toBe(1);
    expect(timers.jobs.filter((job) => !job.cancelled)).toHaveLength(1);
    await queue.flush();
    expect(batches).toEqual([[sample(0)], [sample(1)]]);
  });

  it("defers sends and uses one timer for queued samples", async () => {
    const timers = scheduler();
    const started = deferred();
    const batches: ReadonlyArray<ClientActionTiming>[] = [];
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async (batch) => {
        batches.push(batch);
        started.resolve();
      },
      enabled: () => true,
    });

    queue.enqueue(sample(0));
    queue.enqueue(sample(1));
    queue.enqueue(sample(2));

    expect(timers.jobs).toHaveLength(1);
    expect(timers.jobs[0]?.delayMs).toBe(1_000);
    expect(batches).toHaveLength(0);
    expect(queue.stats()).toEqual({ queued: 3, dropped: 0, failed: 0, sent: 0 });

    timers.jobs[0]!.callback();
    await started.promise;
    expect(batches).toEqual([[sample(0), sample(1), sample(2)]]);
    await queue.flush();
    expect(batches).toEqual([[sample(0), sample(1), sample(2)]]);
    expect(queue.stats()).toEqual({ queued: 0, dropped: 0, failed: 0, sent: 3 });
  });

  it("caps each batch at 16 and drains the remaining samples", async () => {
    const timers = scheduler();
    const batches: ReadonlyArray<ClientActionTiming>[] = [];
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async (batch) => {
        batches.push(batch);
      },
      enabled: () => true,
      maxQueued: 40,
    });

    for (let index = 0; index < 33; index += 1) queue.enqueue(sample(index));
    await queue.flush();

    expect(batches.map((batch) => batch.length)).toEqual([16, 16, 1]);
    expect(batches.flat()).toEqual(Array.from({ length: 33 }, (_, index) => sample(index)));
    expect(queue.stats()).toEqual({ queued: 0, dropped: 0, failed: 0, sent: 33 });
  });

  it("drops a failed batch and continues with later batches", async () => {
    const timers = scheduler();
    const attempts: ReadonlyArray<ClientActionTiming>[] = [];
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async (batch) => {
        attempts.push(batch);
        if (attempts.length === 1) throw new Error("offline");
      },
      enabled: () => true,
    });

    for (let index = 0; index < 17; index += 1) queue.enqueue(sample(index));
    await queue.flush();

    expect(attempts.map((batch) => batch.length)).toEqual([16, 1]);
    expect(queue.stats()).toEqual({ queued: 0, dropped: 16, failed: 16, sent: 1 });
  });

  it("bounds pending samples and drops the oldest sample", async () => {
    const timers = scheduler();
    const batches: ReadonlyArray<ClientActionTiming>[] = [];
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async (batch) => {
        batches.push(batch);
      },
      enabled: () => true,
      maxQueued: 2,
    });

    queue.enqueue(sample(0));
    queue.enqueue(sample(1));
    queue.enqueue(sample(2));
    expect(queue.stats()).toEqual({ queued: 2, dropped: 1, failed: 0, sent: 0 });
    await queue.flush();

    expect(batches).toEqual([[sample(1), sample(2)]]);
  });

  it("caps configured queue sizes", () => {
    const timers = scheduler();
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async () => undefined,
      enabled: () => true,
      maxQueued: Number.MAX_SAFE_INTEGER,
    });

    for (let index = 0; index < 4_098; index += 1) queue.enqueue(sample(index));

    expect(queue.stats()).toEqual({ queued: 4_096, dropped: 2, failed: 0, sent: 0 });
  });

  it("clears queued samples when consent turns off during a send", async () => {
    const timers = scheduler();
    const started = deferred();
    const release = deferred();
    const batches: ReadonlyArray<ClientActionTiming>[] = [];
    let enabled = true;
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async (batch) => {
        batches.push(batch);
        started.resolve();
        await release.promise;
      },
      enabled: () => enabled,
    });

    for (let index = 0; index < 17; index += 1) queue.enqueue(sample(index));
    const flushing = queue.flush();
    await started.promise;
    enabled = false;
    await queue.flush();
    release.resolve();
    await flushing;

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(16);
    expect(queue.stats()).toEqual({ queued: 0, dropped: 1, failed: 0, sent: 16 });
  });

  it("does not send queued samples from an old account after clear", async () => {
    const timers = scheduler();
    const started = deferred();
    const release = deferred();
    const batches: ReadonlyArray<ClientActionTiming>[] = [];
    const queue = createActionTimingQueue({
      schedule: timers.schedule,
      send: async (batch) => {
        batches.push(batch);
        if (batches.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
      enabled: () => true,
    });

    for (let index = 0; index < 17; index += 1) queue.enqueue(sample(index));
    const oldFlush = queue.flush();
    await started.promise;
    queue.clear();
    queue.enqueue(sample(99));
    const newFlush = queue.flush();

    expect(batches).toHaveLength(1);
    release.resolve();
    await Promise.all([oldFlush, newFlush]);

    expect(batches).toEqual([
      Array.from({ length: 16 }, (_, index) => sample(index)),
      [sample(99)],
    ]);
    expect(queue.stats()).toEqual({ queued: 0, dropped: 1, failed: 0, sent: 17 });
  });

  it("contains synchronous send errors and scheduler errors", async () => {
    const queue = createActionTimingQueue({
      schedule: () => {
        throw new Error("timer unavailable");
      },
      send: () => {
        throw new Error("offline");
      },
      enabled: () => true,
    });

    expect(() => queue.enqueue(sample(0))).not.toThrow();
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.stats()).toEqual({ queued: 0, dropped: 1, failed: 1, sent: 0 });
  });
});
