import type { AutomationStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decisionMarks, nodeRunStates } from "./runState.ts";

const step = (key: string, status: AutomationStep["status"]): AutomationStep => ({
  key,
  nodeId: key,
  verb: "judge",
  label: "Triage",
  status,
  threadId: null,
  args: null,
  result: null,
  error: null,
  errorDetail: null,
  attempt: 1,
  startedAt: "",
  finishedAt: null,
});

describe("nodeRunStates", () => {
  it("sums repeated steps per node and shows the most pressing status", () => {
    const states = nodeRunStates({
      steps: [
        step("s7[0]/s8", "succeeded"),
        step("s7[1]/s8", "failed"),
        step("s7[2]/s8", "running"),
      ],
    });
    expect(states.get("s7/s8")).toMatchObject({ status: "failed", runs: 3, failed: 1, waiting: 0 });
    expect(
      nodeRunStates({ steps: [step("s1", "failed"), step("s1#1", "waiting")] }).get("s1")?.status,
    ).toBe("waiting");
  });
});

describe("decisionMarks", () => {
  it("reads decision marks per node, across loop passes", () => {
    const marks = decisionMarks({
      marks: { s2: 1, "s4[0]/s6": 0, "s4[1]/s6": 2, s9: 0, "s9#1": 1, s3: true, s7: { count: 3 } },
    });
    expect(marks.get("s2")).toEqual({ options: new Set([1]), passes: 1 });
    expect(marks.get("s4/s6")).toEqual({ options: new Set([0, 2]), passes: 2 });
    expect(marks.get("s9")?.options).toEqual(new Set([0, 1]));
    expect(marks.get("s3")?.options).toEqual(new Set([0]));
    expect(marks.has("s7")).toBe(false);
  });
});
