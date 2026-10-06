import type { AutomationStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loopPasses, passSummary, resultLine, runChatItems, runTitle } from "./runs.ts";

const at = (second: number) => `2026-10-06T09:00:${String(second).padStart(2, "0")}.000Z`;

const step = (
  key: string,
  second: number,
  overrides: Partial<AutomationStep> = {},
): AutomationStep => ({
  key,
  nodeId: key,
  verb: "agent",
  label: key,
  status: "succeeded",
  threadId: null,
  args: [],
  result: null,
  error: null,
  errorDetail: null,
  attempt: 1,
  startedAt: at(second),
  finishedAt: at(second + 1),
  ...overrides,
});

const run = {
  title: null,
  status: "succeeded",
  waitingOnYou: false,
  error: null,
  trigger: "cron",
} as const;

describe("runTitle", () => {
  it("prefers what the run said, first line only", () => {
    expect(runTitle({ ...run, title: "\nLooked at 3 issues\nand fixed one" })).toBe(
      "Looked at 3 issues",
    );
  });

  it("falls back to the run's state", () => {
    expect(runTitle({ ...run, status: "running", waitingOnYou: true })).toBe("Waiting on you");
    expect(runTitle({ ...run, status: "running" })).toBe("Running");
    expect(runTitle({ ...run, status: "failed", error: "Timed out\n  at x.ts:1" })).toBe(
      "Timed out",
    );
    expect(runTitle({ ...run, status: "failed" })).toBe("Failed");
    expect(runTitle(run)).toBe("On schedule");
    expect(runTitle({ ...run, trigger: "webhook" })).toBe("From webhook");
  });
});

describe("resultLine", () => {
  it("reads objects as key/value pairs and hides thread ids", () => {
    expect(resultLine({ text: "Done.\nMore", threadId: "t1", items: [1, 2] })).toBe(
      "text: Done. · items: 2 items",
    );
    expect(resultLine("approve")).toBe("approve");
    expect(resultLine(null)).toBeNull();
    expect(resultLine({})).toBeNull();
  });
});

describe("runChatItems", () => {
  it("orders steps by start and gathers a loop's passes where it first ran", () => {
    const items = runChatItems([
      step("s1", 0),
      step("s3", 9),
      step("s2[1]/s4", 5),
      step("s2[0]/s4", 2),
      step("s2[0]/s5", 3),
    ]);
    expect(items.map((item) => (item.kind === "step" ? item.step.key : item.key))).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    const loop = items[1];
    expect(loop?.kind === "loop" && loop.nodeId).toBe("s2");
    expect(
      loop?.kind === "loop" && loop.passes.map((pass) => pass.steps.map((entry) => entry.key)),
    ).toEqual([["s2[0]/s4", "s2[0]/s5"], ["s2[1]/s4"]]);
  });

  it("keeps a loop reached twice as two groups, and loops in helpers keyed by their frame", () => {
    const items = runChatItems([
      step("s2[0]/s4", 0),
      step("s2#1[0]/s4", 4),
      step("s7/s2[0]/s4", 8),
    ]);
    expect(items.map((item) => item.kind === "loop" && [item.key, item.nodeId])).toEqual([
      ["s2", "s2"],
      ["s2#1", "s2"],
      ["s7/s2", "s7/s2"],
    ]);
  });
});

describe("loopPasses", () => {
  it("collects a nested loop's passes across its outer passes", () => {
    const passes = loopPasses(
      [step("s1[0]/s2[0]/s3", 0), step("s1[1]/s2[0]/s3", 2), step("s1[0]/s2[1]/s3", 1)],
      "s1/s2",
    );
    expect(passes.map((pass) => [pass.index, pass.steps.length])).toEqual([
      [0, 2],
      [1, 1],
    ]);
  });
});

describe("passSummary", () => {
  it("shows the most pressing status and the error behind it", () => {
    const summary = passSummary({
      index: 0,
      steps: [
        step("s2[0]/s4", 0, { result: "fine" }),
        step("s2[0]/s5", 2, { status: "failed", error: "Boom" }),
      ],
    });
    expect(summary).toMatchObject({ status: "failed", line: "Boom", durationMs: 3000 });
  });

  it("has no duration while a step is still going", () => {
    const summary = passSummary({
      index: 0,
      steps: [step("s2[0]/s4", 0, { status: "running", finishedAt: null })],
    });
    expect(summary.durationMs).toBeNull();
  });
});
