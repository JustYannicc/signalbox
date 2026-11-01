import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { requireStartupBudget, startupProfileSummary } from "./budget.ts";

const profile = (samples = [1], timeDeltas = [300_000]) => ({
  startTime: 1,
  endTime: 1_000_001,
  nodes: [
    { id: 1, callFrame: { functionName: "startup" } },
    { id: 2, callFrame: { functionName: "(idle)" } },
    { id: 3, callFrame: { functionName: "(garbage collector)" } },
  ],
  samples,
  timeDeltas,
});

describe("Worker startup CPU budget", () => {
  it("orders signed deltas by absolute timestamps before attributing sample durations", () => {
    expect(startupProfileSummary(profile([1, 2, 3], [10, 20, -10]))).toEqual({
      sampleCount: 3,
      negativeDeltaCount: 1,
      profileWindowMs: 1_000,
      sampledMs: 0.03,
      idleMs: 0.01,
      activeMs: 0.02,
      garbageCollectionMs: 0.01,
    });
  });

  it("qualifies the retained out-of-order Workerd profile without changing its timing data", () => {
    // Profile 40d210e9a83f3ded5e2b278cbc04712accd5db707d20fab8a8d973c373044617;
    // only unused node metadata, including private source URLs, was removed.
    const bytes = NodeFS.readFileSync(
      new URL("./fixtures/out-of-order.cpuprofile.json", import.meta.url),
      "utf8",
    );
    const raw = JSON.parse(bytes);
    const summary = requireStartupBudget(raw);
    expect(summary).toEqual({
      sampleCount: 161,
      negativeDeltaCount: 1,
      profileWindowMs: 192.736,
      sampledMs: 185.4176625,
      idleMs: 4.514,
      activeMs: 180.9036625,
      garbageCollectionMs: 22.607,
    });
    expect(JSON.stringify(raw)).toBe(JSON.stringify(JSON.parse(bytes)));
  });

  it.each([0.5, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses a non-integer delta: %s",
    (delta) => expect(() => startupProfileSummary(profile([1, 1], [1_000, delta]))).toThrow(),
  );

  it("attributes ordered variable intervals, excluding idle and including garbage collection", () => {
    expect(
      startupProfileSummary(profile([1, 2, 3, 1], [100_000, 300_000, 100_000, 200_000])),
    ).toEqual({
      sampleCount: 4,
      negativeDeltaCount: 0,
      profileWindowMs: 1_000,
      sampledMs: 800,
      idleMs: 100,
      activeMs: 700,
      garbageCollectionMs: 200,
    });
  });

  it("accepts 300 ms and refuses the first microsecond above it", () => {
    expect(requireStartupBudget(profile()).activeMs).toBe(300);
    expect(() => requireStartupBudget(profile([1], [300_001]))).toThrow("BUDGET_EXCEEDED");
  });

  it.each([
    profile([1, 1], [-10, 20]),
    { ...profile([1, 1], [100, 100]), endTime: 101 },
    profile([1, 4], [100, -10]),
  ])("refuses invalid timestamps and unknown sample IDs after sorting", (raw) => {
    expect(() => startupProfileSummary(raw)).toThrow();
  });

  it.each([
    [[], []],
    [[1], []],
    [[4], [1_000]],
    [[1], [-1]],
    [[1], [Number.NaN]],
    [[2], [1_000]],
  ])("refuses missing, invalid or entirely idle measurements: %j / %j", (samples, intervals) => {
    expect(() => requireStartupBudget(profile(samples, intervals))).toThrow();
  });
});
