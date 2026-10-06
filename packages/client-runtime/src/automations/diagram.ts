import {
  workflowNodeIdForStepKey,
  workflowStepKeyFrames,
  type AutomationRunDetail,
  type WorkflowBranchNode,
  type WorkflowGraph,
  type WorkflowLoopNode,
  type WorkflowNode,
} from "@t3tools/contracts";

import type { LayoutEdge, WorkflowLayout } from "./layout.ts";
import { childNodes } from "./runs.ts";
import { decisionMarks, nodeRunStates, type NodeRunState } from "./runState.ts";
import { stepDisplayStatus, type AutomationDisplayStatus } from "./status.ts";

/**
 * One run drawn over a laid-out automation. Only steps record runs, and
 * decisions, loops and try blocks record which way they went (`marks`); the
 * rest is inferred: a box ran when anything inside it ran, a decision took the
 * option whose first step ran, and an option that goes straight to an early
 * return was taken when the decision ran and took no other. Edges the run
 * can't speak for stay plain.
 */

export type EdgeRunState = "plain" | "taken" | "untaken";

export interface DiagramRun {
  readonly states: ReadonlyMap<string, NodeRunState>;
  /** Cards and boxes the run got to. The trigger always is. */
  readonly reached: ReadonlySet<string>;
  readonly edges: ReadonlyMap<string, EdgeRunState>;
  /** Loop box id → "3/5", "4×". */
  readonly loops: ReadonlyMap<string, string>;
  /** The step that most needs a look: a question for you, else a failure, else what's running. */
  readonly focus: { readonly id: string; readonly status: AutomationDisplayStatus } | null;
}

type Run = Pick<AutomationRunDetail, "steps" | "marks">;

interface GraphIndex {
  readonly branches: Map<string, WorkflowBranchNode>;
  readonly loops: Map<string, WorkflowLoopNode>;
  /** Every node id nested inside a decision, loop, parallel group or try. */
  readonly descendants: Map<string, string[]>;
}

function indexGraph(graph: WorkflowGraph): GraphIndex {
  const index: GraphIndex = { branches: new Map(), loops: new Map(), descendants: new Map() };
  const visit = (nodes: ReadonlyArray<WorkflowNode>): string[] =>
    nodes.flatMap((node) => {
      const children = visit(childNodes(node));
      if (node.type === "branch") index.branches.set(node.id, node);
      if (node.type === "loop") index.loops.set(node.id, node);
      if (children.length > 0) index.descendants.set(node.id, children);
      return [node.id, ...children];
    });
  visit(graph.nodes);
  return index;
}

/** For a decision without marks: the option named by the answer that decided it. */
function answeredArm(branch: WorkflowBranchNode, run: Run): number | null {
  if (branch.source !== "outcome" || !branch.decidedBy) return null;
  const answer = run.steps.findLast(
    (step) =>
      step.status === "succeeded" && workflowNodeIdForStepKey(step.key) === branch.decidedBy,
  )?.result;
  if (typeof answer !== "string") return null;
  const match = branch.arms.findIndex((arm) => arm.label === answer);
  if (match >= 0) return match;
  const otherwise = branch.arms.findIndex((arm) => arm.label === "Otherwise");
  return otherwise >= 0 ? otherwise : null;
}

/** Per loop node: passes that ran (highest pass + 1), and the item count an `each` marked. */
function loopCounts(run: Run) {
  const passes = new Map<string, number>();
  for (const step of run.steps) {
    for (const frame of workflowStepKeyFrames(step.key)) {
      const loopId = workflowNodeIdForStepKey(frame.loopKey);
      passes.set(loopId, Math.max(passes.get(loopId) ?? 0, frame.pass + 1));
    }
  }
  const items = new Map<string, number>();
  for (const [key, value] of Object.entries(run.marks)) {
    if (typeof value !== "object" || value === null || !("count" in value)) continue;
    if (typeof value.count !== "number") continue;
    const loopId = workflowNodeIdForStepKey(key);
    items.set(loopId, Math.max(items.get(loopId) ?? 0, value.count));
  }
  return { passes, items };
}

const FOCUS_RANK: Partial<Record<AutomationDisplayStatus, number>> = {
  needsYou: 3,
  failed: 2,
  working: 1,
  waiting: 1,
};

export function diagramRun(layout: WorkflowLayout, graph: WorkflowGraph, run: Run): DiagramRun {
  const index = indexGraph(graph);
  const states = nodeRunStates(run);
  const marks = decisionMarks(run);
  const descendants = (id: string) => index.descendants.get(id) ?? [];

  // Every node a step ran at or inside: a step at `s7/s8` also ran inside `s7`.
  const ranAt = new Set<string>();
  for (const id of states.keys()) {
    ranAt.add(id);
    for (let at = 0; at < id.length; at++) {
      if (id[at] === "/" || id[at] === ".") ranAt.add(id.slice(0, at));
    }
  }
  const ran = (id: string) =>
    ranAt.has(id) ||
    marks.has(id) ||
    descendants(id).some((child) => ranAt.has(child) || marks.has(child));
  // Everything at or inside `id` ran and succeeded, so whatever comes next was evaluated.
  const finished = (id: string) => {
    const own = states.get(id);
    if (own) return own.status === "succeeded";
    const inner = descendants(id).flatMap((child) => states.get(child) ?? []);
    return inner.length > 0 && inner.every((state) => state.status === "succeeded");
  };

  const ends = new Set(layout.cards.flatMap((card) => (card.kind === "end" ? [card.id] : [])));
  const incoming = new Map<string, LayoutEdge>();
  const arms = new Map<string, LayoutEdge[]>();
  for (const edge of layout.edges) {
    if (edge.to !== null && !incoming.has(edge.to)) incoming.set(edge.to, edge);
    if (edge.arm) arms.set(edge.arm.decisionId, [...(arms.get(edge.arm.decisionId) ?? []), edge]);
  }
  const answered = new Map<string, number>();
  for (const branch of index.branches.values()) {
    const arm = marks.has(branch.id) ? null : answeredArm(branch, run);
    if (arm !== null) answered.set(branch.id, arm);
  }

  // The first card or box below the edge; early returns record nothing, so they don't count.
  const tracedTarget = (edge: LayoutEdge) => {
    const target = edge.via[0] ?? edge.to;
    return target === null || ends.has(target) ? null : target;
  };

  const memo = new Map<string, boolean>();
  const isReached = (id: string): boolean => {
    if (id === "trigger") return true;
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    let result = ran(id);
    const branch = index.branches.get(id);
    if (!result && branch) {
      const above = incoming.get(id);
      result =
        answered.has(id) ||
        (branch.decidedBy !== undefined && finished(branch.decidedBy)) ||
        (arms.get(id) ?? []).some((edge) => {
          const target = tracedTarget(edge);
          return target !== null && isReached(target);
        }) ||
        // A decision right below something that finished was evaluated.
        (above !== undefined && above.arm === null && above.from !== null && finished(above.from));
    } else if (!result && ends.has(id)) {
      const edge = incoming.get(id);
      result = edge !== undefined && edgeState(edge) === "taken";
    }
    memo.set(id, result);
    return result;
  };

  // An option that goes straight to an early return was taken exactly when no other option was.
  const tracelessArm = (decisionId: string): EdgeRunState => {
    if (!isReached(decisionId)) return "untaken";
    const siblings = arms.get(decisionId) ?? [];
    const traced = siblings.flatMap((edge) => tracedTarget(edge) ?? []);
    if (traced.some(isReached)) return "untaken";
    return siblings.length - traced.length === 1 ? "taken" : "plain";
  };

  const edgeState = (edge: LayoutEdge): EdgeRunState => {
    if (edge.arm) {
      // Decisions in a loop can take several options across passes; marks have them all.
      const mark = marks.get(edge.arm.decisionId);
      if (mark) return mark.options.has(edge.arm.index) ? "taken" : "untaken";
      const answer = answered.get(edge.arm.decisionId);
      if (answer !== undefined) return answer === edge.arm.index ? "taken" : "untaken";
    }
    const target = tracedTarget(edge);
    if (target !== null) return isReached(target) ? "taken" : "untaken";
    if (edge.arm && index.branches.has(edge.arm.decisionId)) {
      return tracelessArm(edge.arm.decisionId);
    }
    if (edge.from !== null) return isReached(edge.from) ? "taken" : "untaken";
    return "plain";
  };

  const reached = new Set<string>();
  for (const item of [...layout.cards, ...layout.containers]) {
    if (isReached(item.id)) reached.add(item.id);
  }
  const edges = new Map(layout.edges.map((edge) => [edge.id, edgeState(edge)] as const));

  const counts = loopCounts(run);
  const loops = new Map<string, string>();
  for (const loop of index.loops.values()) {
    const progress = loopProgress(
      loop,
      counts,
      // A plain loop records how often it went round; older runs only have the body's steps.
      () =>
        marks.get(loop.id)?.passes ??
        Math.max(0, ...descendants(loop.id).map((id) => states.get(id)?.runs ?? 0)),
    );
    if (progress) loops.set(loop.id, progress);
  }

  let focus: DiagramRun["focus"] = null;
  for (const card of layout.cards) {
    if (card.kind !== "step") continue;
    const state = states.get(card.id);
    if (!state) continue;
    const status = stepDisplayStatus({ status: state.status, verb: card.node.verb });
    if ((FOCUS_RANK[status] ?? 0) > (focus ? (FOCUS_RANK[focus.status] ?? 0) : 0)) {
      focus = { id: card.id, status };
    }
  }

  return { states, reached, edges, loops, focus };
}

/** "3/5" for a repeat or each, "4×" for a plain loop that ran more than once. */
function loopProgress(
  loop: WorkflowLoopNode,
  counts: ReturnType<typeof loopCounts>,
  roundsOfPlainLoop: () => number,
): string | null {
  if (loop.verb === "for" || loop.verb === "while") {
    const rounds = roundsOfPlainLoop();
    return rounds > 1 ? `${rounds}×` : null;
  }
  const passes = counts.passes.get(loop.id) ?? 0;
  // An `each` marks its item count up front; a repeat's total is its `max`.
  const items = loop.verb === "each" ? counts.items.get(loop.id) : undefined;
  if (items !== undefined) return `${passes}/${items}`;
  if (passes === 0) return null;
  return loop.verb === "repeat" && loop.max ? `${passes}/${loop.max}` : `${passes}×`;
}

/** An orthogonal polyline as an SVG path with its corners rounded by up to `radius`. */
export function roundedPath(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  radius: number,
): string {
  const [start, ...rest] = points;
  if (!start) return "";
  let path = `M${start.x} ${start.y}`;
  rest.forEach((corner, index) => {
    const previous = points[index]!;
    const next = rest[index + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = next ? Math.hypot(next.x - corner.x, next.y - corner.y) : 0;
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (!next || r <= 0) {
      path += ` L${corner.x} ${corner.y}`;
      return;
    }
    const before = {
      x: corner.x - ((corner.x - previous.x) / inLength) * r,
      y: corner.y - ((corner.y - previous.y) / inLength) * r,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLength) * r,
      y: corner.y + ((next.y - corner.y) / outLength) * r,
    };
    path += ` L${before.x} ${before.y} Q${corner.x} ${corner.y} ${after.x} ${after.y}`;
  });
  return path;
}
