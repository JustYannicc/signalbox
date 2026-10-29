// @effect-diagnostics globalDate:off globalTimers:off - Test native deadline clocks without an Effect runtime.
import { describe, expect, it, vi } from "@effect/vitest";
import { createResponseSamplingQueue, type ResponseSampleOutcome } from "./heapSampling.ts";

describe("response sampling admission", () => {
  it("keeps external response demand active until the last transport joins", async () => {
    const held = Promise.withResolvers<number>();
    const counts: number[] = [];
    const queue = createResponseSamplingQueue({
      generation: "root-1",
      timeoutMs: 30_000,
      sample: async () => held.promise,
      onOutcome: () => undefined,
      onPendingChange: (count: number) => counts.push(count),
    });
    queue.enqueue({
      id: "0",
      context: 0,
      respondedAtMs: performance.timeOrigin + performance.now(),
    });
    await Promise.resolve();
    const closing = queue.close({ cancel: true });
    expect(counts.at(-1)).toBe(1);
    held.resolve(0);
    await closing;
    expect(counts.at(-1)).toBe(0);
  });
  it("serves a 112-response burst before admitting one measurement at a time", async () => {
    const release = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    const outcomes: ResponseSampleOutcome<number, number>[] = [];
    let active = 0;
    let peak = 0;
    let refusals = 0;
    let served = 0;
    const queue = createResponseSamplingQueue({
      generation: "root-1",
      timeoutMs: 30_000,
      onOutcome: (outcome: ResponseSampleOutcome<number, number>) => outcomes.push(outcome),
      sample: async (index: number) => {
        if (active >= 32) {
          refusals++;
          throw new Error("HTTP 429");
        }
        active++;
        peak = Math.max(peak, active);
        first.resolve();
        try {
          await release.promise;
          return index;
        } finally {
          active--;
        }
      },
    });

    for (let index = 0; index < 112; index++) {
      queue.enqueue({
        id: String(index),
        context: index,
        respondedAtMs: performance.timeOrigin + performance.now(),
      });
      served++;
    }
    expect(served).toBe(112);
    expect(active).toBe(0);
    expect(outcomes).toHaveLength(0);
    await first.promise;
    expect(queue.snapshot()).toMatchObject({ queued: 111, inFlight: 1 });
    release.resolve();
    await queue.close();

    expect(peak).toBe(1);
    expect(refusals).toBe(0);
    expect(outcomes).toHaveLength(112);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(Array(112).fill("sampled"));
    expect(outcomes.map((outcome) => outcome.context)).toEqual(
      Array.from({ length: 112 }, (_, i) => i),
    );
    expect(queue.snapshot()).toMatchObject({
      pending: 0,
      queued: 0,
      inFlight: 0,
      sampled: 112,
      gaps: 0,
    });
  });

  it("expires queued work against response time and keeps the transport slot until it joins", async () => {
    vi.useFakeTimers();
    try {
      const held = Promise.withResolvers<number>();
      const outcomes: ResponseSampleOutcome<number, number>[] = [];
      const sample = vi.fn(async () => held.promise);
      const queue = createResponseSamplingQueue({
        generation: "root-1",
        timeoutMs: 100,
        clock: {
          now: () => Date.now(),
          schedule: (callback, ms) => {
            const timer = setTimeout(callback, ms);
            return () => clearTimeout(timer);
          },
        },
        sample,
        onOutcome: (outcome: ResponseSampleOutcome<number, number>) => outcomes.push(outcome),
      });
      queue.enqueue({ id: "0", context: 0, respondedAtMs: Date.now() - 90 });
      queue.enqueue({ id: "1", context: 1, respondedAtMs: Date.now() - 90 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(outcomes.map((outcome) => outcome.status === "gap" && outcome.reason)).toEqual([
        "deadline-expired-in-flight",
        "deadline-expired-in-queue",
      ]);
      expect(sample).toHaveBeenCalledTimes(1);
      expect(queue.snapshot().inFlight).toBe(1);
      held.resolve(0);
      await queue.close();
      expect(outcomes).toHaveLength(2);
      expect(queue.snapshot().inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("separates generations and ignores duplicate telemetry without a second verdict", async () => {
    const first = Promise.withResolvers<number>();
    const outcomes: ResponseSampleOutcome<number, number>[] = [];
    const queue = createResponseSamplingQueue({
      generation: "root-1",
      timeoutMs: 30_000,
      sample: async (value: number) => (value === 1 ? first.promise : value),
      onOutcome: (outcome: ResponseSampleOutcome<number, number>) => outcomes.push(outcome),
    });
    const now = () => performance.timeOrigin + performance.now();
    queue.enqueue({ id: "same", context: 1, respondedAtMs: now() });
    queue.enqueue({ id: "same", context: 1, respondedAtMs: now() });
    await Promise.resolve();
    queue.changeGeneration("root-2");
    queue.enqueue({ id: "same", context: 2, respondedAtMs: now() });
    first.resolve(1);
    await queue.close();
    expect(outcomes.map((outcome) => [outcome.generation, outcome.status])).toEqual([
      ["root-1", "gap"],
      ["root-2", "sampled"],
    ]);
    expect(queue.snapshot()).toMatchObject({
      duplicateResponses: 1,
      generations: [
        { generation: "root-1", responses: 1, sampled: 0, gaps: 1 },
        { generation: "root-2", responses: 1, sampled: 1, gaps: 0 },
      ],
    });
  });

  it("labels capacity, invalid-time and closed responses without calling the transport", async () => {
    const held = Promise.withResolvers<number>();
    const outcomes: ResponseSampleOutcome<number, number>[] = [];
    const sample = vi.fn(async () => held.promise);
    const queue = createResponseSamplingQueue({
      generation: "root-1",
      timeoutMs: 30_000,
      maxPending: 1,
      sample,
      onOutcome: (outcome: ResponseSampleOutcome<number, number>) => outcomes.push(outcome),
    });
    const now = performance.timeOrigin + performance.now();
    queue.enqueue({ id: "first", context: 0, respondedAtMs: now });
    queue.enqueue({ id: "capacity", context: 1, respondedAtMs: now });
    queue.enqueue({ id: "invalid", context: 2, respondedAtMs: Number.NaN });
    const closing = queue.close({ cancel: true });
    queue.enqueue({ id: "closed", context: 3, respondedAtMs: now });
    held.resolve(0);
    await closing;
    expect(sample).not.toHaveBeenCalled();
    expect(outcomes.map((outcome) => outcome.status === "gap" && outcome.reason)).toEqual([
      "queue-closed",
      "queue-capacity",
      "invalid-response-time",
      "queue-closed",
    ]);
    expect(queue.snapshot()).toMatchObject({ responses: 4, sampled: 0, gaps: 4, pending: 0 });
  });
});
