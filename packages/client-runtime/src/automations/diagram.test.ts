import type { AutomationStep, WorkflowGraph, WorkflowNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diagramRun, roundedPath } from "./diagram.ts";
import { layoutWorkflow } from "./layout.ts";

const label = (text: string) => ({ text, dynamic: false });
const step = (id: string, verb: "agent" | "notify" | "ask" = "agent"): WorkflowNode => ({
  type: "step",
  id,
  line: 1,
  verb,
  label: label(id),
  detail: {},
});
const end = (id: string): WorkflowNode => ({ type: "end", id, line: 3, exit: "workflow" });

const ran = (
  key: string,
  overrides: Partial<Pick<AutomationStep, "status" | "result" | "verb">> = {},
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
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("diagramRun on an answered decision and loops", () => {
  const graph: WorkflowGraph = {
    nodes: [
      step("s1", "ask"),
      {
        type: "branch",
        id: "s2",
        line: 2,
        source: "outcome",
        decidedBy: "s1",
        label: label("Approved?"),
        arms: [
          { label: "approve", body: [step("s3", "notify")] },
          { label: "Otherwise", body: [end("s4")] },
        ],
      },
      {
        type: "branch",
        id: "s5",
        line: 4,
        source: "condition",
        label: label("Any issues?"),
        arms: [
          { label: "Yes", body: [end("s6")] },
          { label: "No", body: [] },
        ],
      },
      {
        type: "loop",
        id: "s7",
        line: 6,
        verb: "each",
        label: label("Each issue"),
        body: [step("s7/s8")],
      },
      {
        type: "loop",
        id: "s9",
        line: 7,
        verb: "repeat",
        max: 5,
        label: label("Until green"),
        body: [step("s9/s10")],
      },
    ],
  };
  const layout = layoutWorkflow(graph, "When you run it");
  const draw = (steps: AutomationStep[], marks: Record<string, unknown> = {}) =>
    diagramRun(layout, graph, { steps, marks });

  it("follows the answer that decided a decision", () => {
    const run = draw([ran("s1", { result: "approve" }), ran("s3")]);
    expect(run.edges.get("s2:arm:0")).toBe("taken");
    expect(run.edges.get("s2:arm:1")).toBe("untaken");
    expect(run.reached.has("s4")).toBe(false);
  });

  it("takes the arm that only ends the run when the answer matched no option", () => {
    const run = draw([ran("s1", { result: "reject" })]);
    expect(run.edges.get("s2:arm:0")).toBe("untaken");
    expect(run.edges.get("s2:arm:1")).toBe("taken");
    expect(run.reached.has("s4")).toBe(true);
  });

  it("reads a w.when decision from its mark", () => {
    const run = draw([ran("s1", { result: "approve" }), ran("s3")], { s5: true });
    expect(run.edges.get("s5:arm:0")).toBe("taken");
    expect(run.edges.get("s5:arm:1")).toBe("untaken");
    expect(run.reached.has("s6")).toBe(true);
  });

  it("counts loop iterations against their total", () => {
    const run = draw(
      [
        ran("s1", { result: "approve" }),
        ran("s3"),
        ran("s7[0]/s8"),
        ran("s7[1]/s8"),
        ran("s7[2]/s8"),
        ran("s9[0]/s10"),
        ran("s9[1]/s10"),
      ],
      { s5: false, s7: { count: 4 }, s9: { attempts: 2, done: true } },
    );
    expect(run.loops.get("s7")).toBe("3/4");
    expect(run.loops.get("s9")).toBe("2/5");
    expect(run.reached.has("s7")).toBe(true);
    expect(run.states.get("s7/s8")?.runs).toBe(3);
  });

  it("prefers the option the run recorded over reading the answer", () => {
    // The answer alone would pick "approve"; the run recorded that it ended instead.
    const run = draw([ran("s1", { result: "approve" })], { s2: 1 });
    expect(run.edges.get("s2:arm:0")).toBe("untaken");
    expect(run.edges.get("s2:arm:1")).toBe("taken");
    expect(run.reached.has("s4")).toBe(true);
  });

  it("shows every option a decision took across loop passes", () => {
    const run = draw([ran("s1", { result: "approve" })], { s5: 0, "s5#1": 1 });
    expect(run.edges.get("s5:arm:0")).toBe("taken");
    expect(run.edges.get("s5:arm:1")).toBe("taken");
  });

  it("leaves untouched parts of the diagram unreached", () => {
    const run = draw([]);
    expect(run.reached.has("trigger")).toBe(true);
    expect(run.reached.has("s1")).toBe(false);
    expect(run.edges.get("s2:arm:0")).toBe("untaken");
    expect(run.loops.size).toBe(0);
    expect(run.focus).toBeNull();
  });

  it("doesn't decide while the question is still open", () => {
    const run = draw([ran("s1", { verb: "ask", status: "waiting" })]);
    expect(run.reached.has("s2")).toBe(false);
    expect(run.edges.get("s2:arm:1")).toBe("untaken");
    expect(run.focus).toEqual({ id: "s1", status: "needsYou" });
  });
});

describe("diagramRun on a decision with an early return", () => {
  const graph: WorkflowGraph = {
    nodes: [
      step("s1"),
      {
        type: "branch",
        id: "s2",
        line: 2,
        source: "condition",
        label: label("How urgent?"),
        arms: [
          { label: "fatal", body: [step("s3")] },
          { label: "Otherwise", body: [end("s4")] },
        ],
      },
      step("s5"),
    ],
  };
  const layout = layoutWorkflow(graph, "Every hour");
  const draw = (steps: AutomationStep[], marks: Record<string, unknown> = {}) =>
    diagramRun(layout, graph, { steps, marks });

  it("follows the option a run took and focuses what's still going", () => {
    const run = draw([ran("s1"), ran("s3"), ran("s5", { status: "running" })]);
    expect(run.reached.has("s3")).toBe(true);
    expect(run.reached.has("s4")).toBe(false);
    expect(run.edges.get("s2:arm:0")).toBe("taken");
    expect(run.edges.get("s2:arm:1")).toBe("untaken");
    expect(run.focus).toEqual({ id: "s5", status: "working" });
  });

  it("infers an option that went straight to an early return", () => {
    const run = draw([ran("s1")]);
    expect(run.reached.has("s2")).toBe(true);
    expect(run.edges.get("s2:arm:0")).toBe("untaken");
    expect(run.edges.get("s2:arm:1")).toBe("taken");
    expect(run.reached.has("s4")).toBe(true);
    expect(run.reached.has("s5")).toBe(false);
  });

  it("infers nothing while the step above is still going", () => {
    const run = draw([ran("s1", { status: "running" })]);
    expect(run.reached.has("s2")).toBe(false);
    expect(run.edges.get("s2:arm:1")).toBe("untaken");
  });

  it("takes the option the run recorded, even one that just returns", () => {
    const run = draw([], { s2: 1 });
    expect(run.edges.get("s2:arm:0")).toBe("untaken");
    expect(run.edges.get("s2:arm:1")).toBe("taken");
  });
});

describe("roundedPath", () => {
  it("keeps straight lines straight and rounds dog-legs", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 10 },
        ],
        6,
      ),
    ).toBe("M0 0 L0 10");
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 20 },
          { x: 40, y: 20 },
        ],
        6,
      ),
    ).toBe("M0 0 L0 14 Q0 20 6 20 L40 20");
    expect(roundedPath([], 6)).toBe("");
  });
});
