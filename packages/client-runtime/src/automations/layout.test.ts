import type { WorkflowGraph, WorkflowNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { layoutWorkflow, type LayoutCard } from "./layout.ts";

const label = (text: string) => ({ text, dynamic: false });
const step = (
  id: string,
  text: string,
  verb: "agent" | "notify" | "judge" = "agent",
): WorkflowNode => ({
  type: "step",
  id,
  line: 1,
  verb,
  label: label(text),
  detail: {},
});

const graph: WorkflowGraph = {
  nodes: [
    step("s1", "Fetch issues"),
    {
      type: "branch",
      id: "s2",
      line: 2,
      source: "condition",
      label: label("How urgent?"),
      arms: [
        { label: "fatal", body: [step("s3", "Page me", "notify")] },
        { label: "error", body: [step("s4", "Investigate"), step("s5", "Fix it")] },
        { label: "Otherwise", body: [{ type: "end", id: "s6", line: 3, exit: "workflow" }] },
      ],
    },
    {
      type: "loop",
      id: "s7",
      line: 4,
      verb: "each",
      label: label("Each issue"),
      concurrency: 2,
      body: [step("s7/s8", "Triage", "judge")],
    },
    {
      type: "try",
      id: "s9",
      line: 5,
      label: label("If something fails"),
      body: [step("s10", "Post to Slack")],
      failure: [step("s11", "Tell me", "notify")],
    },
    step("s12", "Report", "notify"),
  ],
};

function overlaps(a: LayoutCard, b: LayoutCard) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("layoutWorkflow", () => {
  const layout = layoutWorkflow(graph, "Every hour");
  const card = (id: string) => layout.cards.find((candidate) => candidate.id === id)!;

  it("runs top to bottom", () => {
    const order = ["trigger", "s1", "s2", "s3", "s7/s8", "s10", "s12"].map((id) => card(id).y);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it("puts a decision's options side by side, left to right in code order", () => {
    const arms = ["s3", "s4", "s6"].map(card);
    expect(new Set(arms.map((arm) => arm.y)).size).toBe(1);
    expect(arms.map((arm) => arm.x)).toEqual(arms.map((arm) => arm.x).toSorted((a, b) => a - b));
    expect(card("s5").y).toBeGreaterThan(card("s4").y);
    const labels = layout.edges.filter((edge) => edge.label).map((edge) => edge.label);
    expect(labels).toEqual(expect.arrayContaining(["fatal", "error", "Otherwise", "If it fails"]));
  });

  it("never overlaps cards and keeps everything inside the canvas", () => {
    for (const [index, a] of layout.cards.entries()) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
      expect(a.y + a.height).toBeLessThanOrEqual(layout.height);
      for (const b of layout.cards.slice(index + 1))
        expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
    }
  });

  it("boxes loops and try blocks around their bodies", () => {
    const loop = layout.containers.find((container) => container.id === "s7")!;
    const inner = card("s7/s8");
    expect(loop).toMatchObject({ kind: "each", label: "Each issue", detail: "2 at a time" });
    expect(inner.x).toBeGreaterThan(loop.x);
    expect(inner.y + inner.height).toBeLessThan(loop.y + loop.height);
    expect(layout.edges.some((edge) => edge.failure && edge.label === "If it fails")).toBe(true);
  });

  it("gives every edge a unique id, even when decisions share option names", () => {
    const repeated = layoutWorkflow(
      {
        nodes: ["s1", "s2"].map((id): WorkflowNode => ({
          type: "branch",
          id,
          line: 1,
          source: "condition",
          label: label("Approve?"),
          arms: [
            { label: "approve", body: [step(`${id}a`, "Do it"), step(`${id}b`, "Then this")] },
            { label: "reject", body: [] },
          ],
        })),
      },
      "When you run it",
    );
    const ids = repeated.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws edges as vertical or dog-leg lines that only go down", () => {
    for (const edge of layout.edges) {
      for (let index = 1; index < edge.points.length; index++) {
        const [from, to] = [edge.points[index - 1]!, edge.points[index]!];
        expect(from.x === to.x || from.y === to.y, edge.id).toBe(true);
        expect(to.y).toBeGreaterThanOrEqual(from.y);
      }
    }
  });
});

describe("edge endpoints", () => {
  const typed = layoutWorkflow(
    {
      nodes: [
        step("s1", "Fetch"),
        {
          type: "branch",
          id: "s2",
          line: 2,
          source: "condition",
          label: label("Any?"),
          arms: [
            { label: "Yes", body: [step("s3", "Tell")] },
            { label: "No", body: [] },
          ],
        },
        step("s4", "Report"),
      ],
    },
    "Every hour",
  );
  const edge = (id: string) => typed.edges.find((candidate) => candidate.id === id)!;

  it("names what each edge leaves and enters, and which option it is", () => {
    expect(edge("root:seq:1")).toMatchObject({ from: "trigger", to: "s1", arm: null });
    expect(edge("root:seq:2")).toMatchObject({ from: "s1", to: "s2", arm: null });
    expect(edge("s2:arm:0")).toMatchObject({
      from: "s2",
      to: "s3",
      arm: { decisionId: "s2", index: 0 },
    });
    // An empty option and the joins below a decision end mid-air.
    expect(edge("s2:arm:1")).toMatchObject({ from: "s2", to: null });
    expect(edge("s2:join:0")).toMatchObject({ from: "s3", to: null });
    expect(edge("root:seq:3")).toMatchObject({ from: null, to: "s4" });
  });
});
