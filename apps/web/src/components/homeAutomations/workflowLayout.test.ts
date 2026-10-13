import { describe, expect, it } from "vite-plus/test";

import { AUTOMATIONS } from "./automationFixtures";
import { NODE_HEIGHT, NODE_WIDTH, type WorkflowNode } from "./automationModel";
import { loopGutter, outputAnchors, verticalLayout } from "./workflowLayout";

const overlaps = (a: WorkflowNode, b: WorkflowNode) =>
  a.x < b.x + NODE_WIDTH &&
  b.x < a.x + NODE_WIDTH &&
  a.y < b.y + NODE_HEIGHT &&
  b.y < a.y + NODE_HEIGHT;

describe("verticalLayout", () => {
  it.each(AUTOMATIONS.map((automation) => [automation.id, automation] as const))(
    "%s: cards never overlap and the flow runs downward",
    (_id, automation) => {
      const layout = verticalLayout(automation);
      const byId = new Map(layout.nodes.map((node) => [node.id, node]));
      for (const [index, node] of layout.nodes.entries()) {
        for (const other of layout.nodes.slice(index + 1)) {
          expect(overlaps(node, other), `${node.id} / ${other.id}`).toBe(false);
        }
      }
      for (const edge of automation.edges) {
        const from = byId.get(edge.from)!;
        const to = byId.get(edge.to)!;
        if (edge.loop) expect(to.y).toBeLessThan(from.y);
        else expect(to.y).toBeGreaterThan(from.y);
      }
    },
  );

  it("turns authoring columns into rows and keeps branch sides", () => {
    const layout = verticalLayout({
      nodes: [
        { id: "a", title: "A", x: 0, y: 90, config: { kind: "step", fn: "a", summary: "" } },
        { id: "b", title: "B", x: 300, y: 0, config: { kind: "step", fn: "b", summary: "" } },
        { id: "c", title: "C", x: 300, y: 180, config: { kind: "step", fn: "c", summary: "" } },
      ],
      edges: [],
    });
    const [a, b, c] = layout.nodes;
    expect(a!.y).toBe(0);
    expect(b!.y).toBe(c!.y);
    expect(b!.y).toBeGreaterThan(a!.y + NODE_HEIGHT);
    expect(b!.x).toBeLessThan(a!.x);
    expect(c!.x).toBeGreaterThan(a!.x);
  });

  it("routes a review loop up a gutter right of every step it spans", () => {
    const automation = AUTOMATIONS.find((candidate) => candidate.id === "ship-change")!;
    const layout = verticalLayout(automation);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const gutter = loopGutter(layout.nodes, byId.get("retry")!, byId.get("review")!);
    const spanned = layout.nodes.filter(
      (node) => node.y >= byId.get("review")!.y && node.y <= byId.get("retry")!.y,
    );
    for (const node of spanned) expect(gutter).toBeGreaterThan(node.x + NODE_WIDTH);
    const loop = layout.edges.find((placed) => placed.edge.loop)!;
    expect(loop.middle.x).toBe(gutter);
    expect(layout.bounds.maxX).toBeGreaterThan(gutter);
  });

  it("draws owner lanes as columns around each owner's steps", () => {
    const automation = AUTOMATIONS.find((candidate) => candidate.id === "monthly-expenses")!;
    const layout = verticalLayout(automation);
    expect(layout.lanes).toHaveLength(2);
    for (const lane of layout.lanes) {
      for (const node of layout.nodes.filter((n) => n.owner?.label === lane.owner.label)) {
        expect(node.x).toBeGreaterThanOrEqual(lane.x);
        expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(lane.x + lane.width);
      }
    }
    const [left, right] = layout.lanes.toSorted((a, b) => a.x - b.x);
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
  });
});

describe("outputAnchors", () => {
  it("spreads branches across the bottom and sends a gate's retry out the side", () => {
    const judge = outputAnchors({
      kind: "judge",
      model: "Jev",
      question: "?",
      outcomes: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
        { key: "c", label: "C" },
      ],
    });
    expect(judge.map((anchor) => anchor.at.y)).toEqual([NODE_HEIGHT, NODE_HEIGHT, NODE_HEIGHT]);
    expect(judge.map((anchor) => anchor.at.x)).toEqual([
      NODE_WIDTH / 4,
      NODE_WIDTH / 2,
      (NODE_WIDTH * 3) / 4,
    ]);
    const gate = outputAnchors({
      kind: "gate",
      maxIterations: 3,
      retryLabel: "Try again",
      exitLabel: "Give up",
    });
    expect(gate).toEqual([
      { key: "true", at: { x: NODE_WIDTH, y: NODE_HEIGHT / 2 } },
      { key: "false", at: { x: NODE_WIDTH / 2, y: NODE_HEIGHT } },
    ]);
  });
});
