import { describe, expect, it } from "vite-plus/test";
import { requireStartupBudget, startupProfileSummary } from "./budget.ts";

const profile = (samples = [1], timeDeltas = [500_000]) => ({
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
  it("sums the recorded variable intervals, excluding idle and including garbage collection", () => {
    expect(
      startupProfileSummary(profile([1, 2, 3, 1], [100_000, 400_000, 50_000, 200_000])),
    ).toEqual({
      sampleCount: 4,
      profileWindowMs: 1_000,
      sampledMs: 750,
      idleMs: 400,
      activeMs: 350,
      garbageCollectionMs: 50,
    });
  });

  it("accepts 500 ms and refuses the first microsecond above it", () => {
    expect(requireStartupBudget(profile()).activeMs).toBe(500);
    expect(() => requireStartupBudget(profile([1], [500_001]))).toThrow("BUDGET_EXCEEDED");
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
