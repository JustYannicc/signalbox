import { describe, expect, it } from "vite-plus/test";
import { complete, runAsync, runSync, type WasiCall } from "./internal_wasi_calls.ts";

describe("WASI call execution", () => {
  it("keeps yielded values and caught failures in order", async () => {
    const failure = new Error("backend failed");
    const events: unknown[] = [];
    function* call(): WasiCall<number> {
      events.push(yield* complete(1));
      events.push(yield* complete(Promise.resolve(2)));
      try {
        yield* complete(Promise.reject(failure));
      } catch (error) {
        events.push(error);
      }
      return 3;
    }
    let steps = 0;
    expect(
      await runAsync(call(), (step) => {
        steps++;
        return step();
      }),
    ).toBe(3);
    expect(events).toEqual([1, 2, failure]);
    expect(steps).toBe(4);
    expect(runSync(complete(4))).toBe(4);
  });

  it("settles started work before cleanup when the step meter throws", async () => {
    const pending = Promise.withResolvers<number>();
    const started = Promise.withResolvers<void>();
    const failure = new Error("meter stopped");
    const events: string[] = [];
    function* call(): WasiCall<void> {
      try {
        yield* complete(pending.promise);
        events.push("resumed");
      } finally {
        events.push("cleanup");
        yield* complete(Promise.resolve());
      }
    }
    const running = runAsync(call(), (step) => {
      step();
      started.resolve();
      throw failure;
    });
    await started.promise;
    expect(events).toEqual([]);
    pending.resolve(1);
    await expect(running).rejects.toBe(failure);
    expect(events).toEqual(["cleanup"]);
  });

  it("preserves the sync-execution error and its cleanup cause", () => {
    const failure = new Error("cleanup failed");
    const failCleanup = () => {
      throw failure;
    };
    function* call(): WasiCall<void> {
      try {
        yield* complete(Promise.resolve());
      } finally {
        failCleanup();
      }
    }
    expect(() => runSync(call())).toThrow(
      expect.objectContaining({
        message: "WASI call requires asynchronous execution",
        cause: failure,
      }),
    );
  });
});
