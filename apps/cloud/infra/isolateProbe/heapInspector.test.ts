import { describe, expect, it } from "@effect/vitest";
import { createHeapInspectorSampler } from "./heapInspector.ts";

const heapUsage = (usedSize = 8) => ({ usedSize, totalSize: usedSize + 4 });
const context = (generation: string, boundary?: string) => ({
  generation,
  ...(boundary === undefined ? {} : { boundary }),
});

describe("public inspector heap sampling", () => {
  it("holds intervals for responses waiting outside the inspector queue", async () => {
    const order: string[] = [];
    const sampler = createHeapInspectorSampler(async (method) =>
      method === "Runtime.getIsolateId" ? { id: "a" } : heapUsage(),
    );
    sampler.setResponseBacklog(2);
    const interval = sampler
      .sampleInterval(context("a", "interval"))
      .then(() => order.push("interval"));
    await Promise.resolve();
    await sampler.sampleResponse(context("a", "first"));
    order.push("first");
    sampler.setResponseBacklog(1);
    await sampler.sampleResponse(context("a", "second"));
    order.push("second");
    expect(order).toEqual(["first", "second"]);
    sampler.setResponseBacklog(0);
    await interval;
    expect(order).toEqual(["first", "second", "interval"]);
    await sampler.close();
  });
  it("timestamps the inspector call separately from request-progress bookkeeping", async () => {
    let now = 0;
    const sampler = createHeapInspectorSampler(
      async (method) => {
        if (method === "Runtime.getIsolateId") return { id: "isolate-a" };
        now += 5;
        return heapUsage();
      },
      {
        clock: { now: () => now, schedule: () => () => undefined },
        readContext: () => {
          now += 100;
          return now;
        },
      },
    );
    try {
      const result = await sampler.sampleResponse(context("root-a"));
      expect(
        result.observations.map((read) => [read.readStartedAtMs, read.readAcknowledgedAtMs]),
      ).toEqual([
        [100, 105],
        [305, 310],
        [510, 515],
      ]);
    } finally {
      await sampler.close();
    }
  });

  it("reads the isolate identity once and takes three pre-GC usage observations per window", async () => {
    const calls: string[] = [];
    let usedSize = 8;
    let requestProgress = 0;
    const sampler = createHeapInspectorSampler(
      async (method) => {
        calls.push(method);
        if (method === "Runtime.getIsolateId") return { id: "isolate-a" };
        if (method === "Runtime.getHeapUsage") {
          requestProgress++;
          return heapUsage(usedSize++);
        }
        throw new Error(`Unexpected inspector method: ${method}`);
      },
      { readContext: () => requestProgress },
    );

    try {
      const response = await sampler.sampleResponse(context("root-a", "response-1"));
      const interval = await sampler.sampleInterval(context("root-a", "interval-1"));

      expect(calls).toEqual([
        "Runtime.getIsolateId",
        "Runtime.getHeapUsage",
        "Runtime.getHeapUsage",
        "Runtime.getHeapUsage",
        "Runtime.getHeapUsage",
        "Runtime.getHeapUsage",
        "Runtime.getHeapUsage",
      ]);
      expect(response).toMatchObject({
        kind: "response",
        generation: "root-a",
        isolateId: "isolate-a",
        boundary: "response-1",
        granularity: "isolate-aggregate",
        measurement: "pre-gc-inspector-observations",
        gc: { method: null, acknowledged: false },
      });
      expect(response.observations).toHaveLength(3);
      expect(response.observations.map((observation) => observation.usedSize)).toEqual([8, 9, 10]);
      expect(response.observations.map((observation) => observation.requestProgress)).toEqual([
        { before: 0, after: 1 },
        { before: 1, after: 2 },
        { before: 2, after: 3 },
      ]);
      expect(
        response.observations.every((observation) => observation.generation === "root-a"),
      ).toBe(true);
      expect(interval).toMatchObject({
        kind: "interval",
        generation: "root-a",
        isolateId: "isolate-a",
      });
      expect(interval.observations).toHaveLength(3);
    } finally {
      await sampler.close();
    }
  });

  it("runs pending responses before intervals without preempting the active window", async () => {
    const firstReadStarted = Promise.withResolvers<void>();
    const releaseFirstRead = Promise.withResolvers<void>();
    const resolved: string[] = [];
    let heapReads = 0;
    const sampler = createHeapInspectorSampler(async (method) => {
      if (method === "Runtime.getIsolateId") return { id: "isolate-a" };
      if (method === "Runtime.getHeapUsage") {
        heapReads++;
        if (heapReads === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return heapUsage(heapReads);
      }
      throw new Error(`Unexpected inspector method: ${method}`);
    });

    const active = sampler.sampleResponse(context("root-a", "active")).then((sample) => {
      resolved.push(sample.boundary!);
      return sample;
    });
    let queuedInterval: Promise<unknown> | undefined;
    let queuedResponse: Promise<unknown> | undefined;
    try {
      await firstReadStarted.promise;
      queuedInterval = sampler.sampleInterval(context("root-a", "interval")).then((sample) => {
        resolved.push((sample as { boundary: string }).boundary);
        return sample;
      });
      queuedResponse = sampler.sampleResponse(context("root-a", "response")).then((sample) => {
        resolved.push((sample as { boundary: string }).boundary);
        return sample;
      });

      expect(heapReads).toBe(1);
      releaseFirstRead.resolve();
      await Promise.all([active, queuedInterval, queuedResponse]);

      expect(resolved).toEqual(["active", "response", "interval"]);
      expect(heapReads).toBe(9);
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([active, queuedInterval, queuedResponse].filter(Boolean));
      await sampler.close();
    }
  });

  it("keeps the inspector slot occupied until an aborted transport call joins", async () => {
    const firstReadStarted = Promise.withResolvers<void>();
    const releaseFirstRead = Promise.withResolvers<void>();
    const controller = new AbortController();
    const calls: string[] = [];
    let heapReads = 0;
    const sampler = createHeapInspectorSampler(async (method) => {
      calls.push(method);
      if (method === "Runtime.getIsolateId") return { id: "isolate-a" };
      if (method === "Runtime.getHeapUsage") {
        heapReads++;
        if (heapReads === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return heapUsage(heapReads);
      }
      throw new Error(`Unexpected inspector method: ${method}`);
    });

    const aborted = sampler.sampleResponse({ ...context("root-a"), signal: controller.signal });
    let next: Promise<unknown> | undefined;
    try {
      await firstReadStarted.promise;
      next = sampler.sampleResponse(context("root-a", "next"));
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: "aborted" });
      expect(calls).toEqual(["Runtime.getIsolateId", "Runtime.getHeapUsage"]);

      releaseFirstRead.resolve();
      await expect(next).resolves.toMatchObject({ generation: "root-a", boundary: "next" });
      expect(heapReads).toBe(4);
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([aborted, next].filter(Boolean));
      await sampler.close();
    }
  });

  it("keeps the inspector slot occupied until an expired deadline's call joins", async () => {
    const firstReadStarted = Promise.withResolvers<void>();
    const releaseFirstRead = Promise.withResolvers<void>();
    const calls: string[] = [];
    let now = 100;
    let expireDeadline: (() => void) | undefined;
    let heapReads = 0;
    const sampler = createHeapInspectorSampler(
      async (method) => {
        calls.push(method);
        if (method === "Runtime.getIsolateId") return { id: "isolate-a" };
        if (method === "Runtime.getHeapUsage") {
          heapReads++;
          if (heapReads === 1) {
            firstReadStarted.resolve();
            await releaseFirstRead.promise;
          }
          return heapUsage(heapReads);
        }
        throw new Error(`Unexpected inspector method: ${method}`);
      },
      {
        clock: {
          now: () => now,
          schedule: (callback) => {
            expireDeadline = callback;
            return () => {
              expireDeadline = undefined;
            };
          },
        },
      },
    );

    const expired = sampler.sampleResponse({ generation: "root-a", deadlineAtMs: 110 });
    let next: Promise<unknown> | undefined;
    try {
      await firstReadStarted.promise;
      now = 110;
      expireDeadline?.();
      await expect(expired).rejects.toMatchObject({ code: "deadline-expired" });
      next = sampler.sampleInterval(context("root-a", "after-deadline"));
      expect(calls).toEqual(["Runtime.getIsolateId", "Runtime.getHeapUsage"]);

      releaseFirstRead.resolve();
      await expect(next).resolves.toMatchObject({
        generation: "root-a",
        boundary: "after-deadline",
      });
      expect(heapReads).toBe(4);
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([expired, next].filter(Boolean));
      await sampler.close();
    }
  });

  it("does not retry an unknown identity in one generation and recovers at the next boundary", async () => {
    let identityCalls = 0;
    let usageCalls = 0;
    const sampler = createHeapInspectorSampler(async (method) => {
      if (method === "Runtime.getIsolateId") {
        identityCalls++;
        if (identityCalls === 1) throw new Error("inspector unavailable");
        return { id: "isolate-b" };
      }
      if (method === "Runtime.getHeapUsage") {
        usageCalls++;
        return heapUsage(usageCalls);
      }
      throw new Error(`Unexpected inspector method: ${method}`);
    });

    try {
      await expect(sampler.sampleResponse(context("root-a"))).rejects.toMatchObject({
        name: "HeapInspectorGapError",
        code: "isolate-identity-failed",
      });
      await expect(sampler.sampleInterval(context("root-a"))).rejects.toMatchObject({
        name: "HeapInspectorGapError",
        code: "isolate-identity-unavailable",
      });
      expect(identityCalls).toBe(1);
      expect(usageCalls).toBe(0);

      sampler.changeGeneration("root-b");
      await expect(sampler.sampleResponse(context("root-b"))).resolves.toMatchObject({
        generation: "root-b",
        isolateId: "isolate-b",
        observations: [
          { generation: "root-b" },
          { generation: "root-b" },
          { generation: "root-b" },
        ],
      });
      expect(identityCalls).toBe(2);
      expect(usageCalls).toBe(3);
    } finally {
      await sampler.close();
    }
  });

  it("invalidates a generation after a failed heap command and retries only after replacement", async () => {
    let identityCalls = 0;
    let usageCalls = 0;
    const sampler = createHeapInspectorSampler(async (method) => {
      if (method === "Runtime.getIsolateId") {
        identityCalls++;
        return { id: `isolate-${identityCalls}` };
      }
      if (method === "Runtime.getHeapUsage") {
        usageCalls++;
        if (usageCalls === 1) throw new Error("CDP command failed");
        return heapUsage(usageCalls);
      }
      throw new Error(`Unexpected inspector method: ${method}`);
    });

    try {
      await expect(sampler.sampleResponse(context("root-a"))).rejects.toMatchObject({
        code: "inspector-call-failed",
      });
      await expect(sampler.sampleInterval(context("root-a"))).rejects.toMatchObject({
        code: "generation-invalidated",
      });
      expect(identityCalls).toBe(1);
      expect(usageCalls).toBe(1);

      sampler.changeGeneration("root-b");
      await expect(sampler.sampleResponse(context("root-b"))).resolves.toMatchObject({
        generation: "root-b",
        isolateId: "isolate-2",
        observations: [
          { generation: "root-b" },
          { generation: "root-b" },
          { generation: "root-b" },
        ],
      });
      expect(identityCalls).toBe(2);
      expect(usageCalls).toBe(4);
    } finally {
      await sampler.close();
    }
  });

  it("gaps a late old-generation window and waits for its transport call before rebinding", async () => {
    const firstReadStarted = Promise.withResolvers<void>();
    const releaseFirstRead = Promise.withResolvers<void>();
    const calls: string[] = [];
    let heapReads = 0;
    let identityCalls = 0;
    const sampler = createHeapInspectorSampler(async (method) => {
      calls.push(method);
      if (method === "Runtime.getIsolateId") {
        identityCalls++;
        return { id: identityCalls === 1 ? "isolate-a" : "isolate-b" };
      }
      if (method === "Runtime.getHeapUsage") {
        heapReads++;
        if (heapReads === 1) {
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return heapUsage(heapReads);
      }
      throw new Error(`Unexpected inspector method: ${method}`);
    });

    const oldSample = sampler.sampleResponse(context("root-a", "old"));
    let nextSample: Promise<unknown> | undefined;
    try {
      await firstReadStarted.promise;
      sampler.changeGeneration("root-b");
      await expect(oldSample).rejects.toMatchObject({ code: "generation-changed" });
      nextSample = sampler.sampleResponse(context("root-b", "new"));
      expect(identityCalls).toBe(1);
      expect(calls).toEqual(["Runtime.getIsolateId", "Runtime.getHeapUsage"]);

      releaseFirstRead.resolve();
      await expect(nextSample).resolves.toMatchObject({
        generation: "root-b",
        isolateId: "isolate-b",
        boundary: "new",
      });
      expect(identityCalls).toBe(2);
      expect(heapReads).toBe(4);
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([oldSample, nextSample].filter(Boolean));
      await sampler.close();
    }
  });

  it("bounds pending inspector jobs", async () => {
    const heldIdentity = Promise.withResolvers<void>();
    const releaseIdentity = Promise.withResolvers<void>();
    const sampler = createHeapInspectorSampler(
      async (method) => {
        if (method === "Runtime.getIsolateId") {
          heldIdentity.resolve();
          await releaseIdentity.promise;
          return { id: "isolate-a" };
        }
        if (method === "Runtime.getHeapUsage") return heapUsage();
        throw new Error(`Unexpected inspector method: ${method}`);
      },
      { maxPending: 1 },
    );
    const first = sampler.sampleResponse(context("root-a"));
    try {
      await heldIdentity.promise;
      await expect(sampler.sampleInterval(context("root-a"))).rejects.toMatchObject({
        code: "queue-capacity",
      });
      releaseIdentity.resolve();
      await expect(first).resolves.toMatchObject({
        generation: "root-a",
        observations: [{}, {}, {}],
      });
    } finally {
      releaseIdentity.resolve();
      await Promise.allSettled([first]);
      await sampler.close();
    }
  });
});
