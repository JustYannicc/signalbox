/**
 * Lays a workflow out top to bottom for the canvas. Fixtures author nodes
 * along the flow (`x`) and across it (`y`); this turns each distinct `x` into
 * a row and spreads `y` into columns snapped to a half-column grid, so every
 * fixture renders vertically without hand-placed coordinates. Inputs sit on a
 * card's top edge, outputs on its bottom edge (branches spread across it),
 * and loop-backs leave a gate's right side and climb a gutter right of the
 * rows they span. Owner lanes become columns around the nodes each owner runs.
 */
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  nodeOutputs,
  type Automation,
  type NodeOwner,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeConfig,
} from "./automationModel";

export interface Point {
  x: number;
  y: number;
}

export interface PlacedLane {
  owner: NodeOwner;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  edge: WorkflowEdge;
  key: string;
  path: string;
  /** Where the edge's own label (boundary, loop) sits. */
  middle: Point;
  /** Where the source's branch label sits, near the start of the edge. */
  branchAt: Point;
  branchLabel: string | null;
}

export interface WorkflowLayout {
  nodes: readonly WorkflowNode[];
  edges: readonly PlacedEdge[];
  lanes: readonly PlacedLane[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const ROW_GAP = 76;
const ROW_STEP = NODE_HEIGHT + ROW_GAP;
const COLUMN_STEP = NODE_WIDTH + 40;
const HALF_COLUMN = COLUMN_STEP / 2;
/** Canvas pixels per authoring unit across the flow, before snapping. */
const SPREAD = 2.4;
const LOOP_GAP = 56;
const LOOP_RADIUS = 14;
/** Room right of a loop gutter for its centered label. */
const LOOP_LABEL_ROOM = 88;
const LANE_PAD = 24;
const LANE_HEADER = 40;

/** Lower median, so a graph's main spine lands on column zero. */
function spineOf(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/** Rows from the distinct authoring `x`, columns from the spread and snapped `y`. */
function placeNodes(nodes: readonly WorkflowNode[]): WorkflowNode[] {
  const rows = [...new Set(nodes.map((node) => node.x))].toSorted((a, b) => a - b);
  const spine = spineOf(nodes.map((node) => node.y));
  const placed = nodes.map((node) => ({
    ...node,
    x: Math.round(((node.y - spine) * SPREAD) / HALF_COLUMN) * HALF_COLUMN,
    y: rows.indexOf(node.x) * ROW_STEP,
  }));
  // Snapping can pull two cards in a row together; push the later one right.
  for (const rowY of new Set(placed.map((node) => node.y))) {
    const row = placed.filter((node) => node.y === rowY).toSorted((a, b) => a.x - b.x);
    for (let index = 1; index < row.length; index++) {
      row[index]!.x = Math.max(row[index]!.x, row[index - 1]!.x + COLUMN_STEP);
    }
  }
  return placed;
}

/** A gate's retry leaves from the right side, toward its loop gutter. */
function isSideOutput(config: WorkflowNodeConfig, key: string | undefined) {
  return config.kind === "gate" && key === "true";
}

/** Output handles relative to the card's top-left; edges and cards both use these. */
export function outputAnchors(config: WorkflowNodeConfig): { key: string | null; at: Point }[] {
  // Verdicts end the workflow: the intercepted request is allowed, held, or blocked.
  if (config.kind === "verdict") return [];
  const outputs = nodeOutputs(config);
  if (!outputs) return [{ key: null, at: { x: NODE_WIDTH / 2, y: NODE_HEIGHT } }];
  const bottom = outputs.filter((output) => !isSideOutput(config, output.key));
  return outputs.map((output) =>
    isSideOutput(config, output.key)
      ? { key: output.key, at: { x: NODE_WIDTH, y: NODE_HEIGHT / 2 } }
      : {
          key: output.key,
          at: {
            x: (NODE_WIDTH * (bottom.indexOf(output) + 1)) / (bottom.length + 1),
            y: NODE_HEIGHT,
          },
        },
  );
}

function outputPoint(node: WorkflowNode, branch: string | undefined): Point {
  const anchors = outputAnchors(node.config);
  const anchor = anchors.find((candidate) => candidate.key === (branch ?? null)) ?? anchors[0];
  const at = anchor?.at ?? { x: NODE_WIDTH / 2, y: NODE_HEIGHT };
  return { x: node.x + at.x, y: node.y + at.y };
}

function cubicPoint(points: readonly [Point, Point, Point, Point], t: number): Point {
  const [a, b, c, d] = points;
  const u = 1 - t;
  const blend = (key: "x" | "y") =>
    u * u * u * a[key] + 3 * u * u * t * b[key] + 3 * u * t * t * c[key] + t * t * t * d[key];
  return { x: blend("x"), y: blend("y") };
}

/** Right of every card in the rows a loop spans, so it never cuts through a step. */
export function loopGutter(nodes: readonly WorkflowNode[], from: WorkflowNode, to: WorkflowNode) {
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  const spanned = nodes.filter((node) => node.y >= top && node.y <= bottom);
  return Math.max(...spanned.map((node) => node.x + NODE_WIDTH)) + LOOP_GAP;
}

/** Out of the gate's right side, up the gutter, and into the target's right side. */
function loopPath(start: Point, end: Point, gutter: number) {
  const r = LOOP_RADIUS;
  const up = end.y < start.y ? -1 : 1;
  return [
    `M ${start.x} ${start.y}`,
    `L ${gutter - r} ${start.y}`,
    `Q ${gutter} ${start.y} ${gutter} ${start.y + up * r}`,
    `L ${gutter} ${end.y - up * r}`,
    `Q ${gutter} ${end.y} ${gutter - r} ${end.y}`,
    `L ${end.x} ${end.y}`,
  ].join(" ");
}

function placeEdge(
  edge: WorkflowEdge,
  from: WorkflowNode,
  to: WorkflowNode,
  nodes: readonly WorkflowNode[],
) {
  const key = `${edge.from}-${edge.branch ?? ""}-${edge.to}`;
  const branchLabel =
    nodeOutputs(from.config)?.find((output) => output.key === edge.branch)?.label ?? null;
  const start = outputPoint(from, edge.branch);
  if (edge.loop) {
    const end = { x: to.x + NODE_WIDTH, y: to.y + NODE_HEIGHT / 2 };
    const gutter = loopGutter(nodes, from, to);
    return {
      edge,
      key,
      branchLabel,
      gutter,
      path: loopPath(start, end, gutter),
      middle: { x: gutter, y: (start.y + end.y) / 2 },
      branchAt: { x: gutter, y: start.y - Math.sign(start.y - end.y) * 30 },
    };
  }
  const end = { x: to.x + NODE_WIDTH / 2, y: to.y };
  const bend = Math.max(36, (end.y - start.y) / 2);
  const curve = [
    start,
    { x: start.x, y: start.y + bend },
    { x: end.x, y: end.y - bend },
    end,
  ] as const;
  return {
    edge,
    key,
    branchLabel,
    gutter: null,
    path: `M ${start.x} ${start.y} C ${curve[1].x} ${curve[1].y}, ${curve[2].x} ${curve[2].y}, ${end.x} ${end.y}`,
    middle: cubicPoint(curve, 0.5),
    // Closer to the source, where sibling branches are still apart.
    branchAt: cubicPoint(curve, 0.35),
  };
}

/** Columns around each owner's nodes, running the full height of the graph. */
function placeLanes(automation: Pick<Automation, "lanes">, nodes: readonly WorkflowNode[]) {
  if (!automation.lanes || nodes.length === 0) return [];
  const top = Math.min(...nodes.map((node) => node.y)) - LANE_HEADER;
  const bottom = Math.max(...nodes.map((node) => node.y)) + NODE_HEIGHT + LANE_PAD;
  return automation.lanes.flatMap((lane): PlacedLane[] => {
    const owned = nodes.filter((node) => node.owner?.label === lane.owner.label);
    if (owned.length === 0) return [];
    const left = Math.min(...owned.map((node) => node.x)) - LANE_PAD;
    const right = Math.max(...owned.map((node) => node.x)) + NODE_WIDTH + LANE_PAD;
    return [{ owner: lane.owner, x: left, y: top, width: right - left, height: bottom - top }];
  });
}

export function verticalLayout(
  automation: Pick<Automation, "nodes" | "edges" | "lanes">,
): WorkflowLayout {
  const nodes = placeNodes(automation.nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const placed = automation.edges.flatMap((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    return from && to ? [placeEdge(edge, from, to, nodes)] : [];
  });
  const lanes = placeLanes(automation, nodes);
  const gutters = placed.flatMap((edge) => (edge.gutter === null ? [] : [edge.gutter]));
  const bounds =
    nodes.length === 0
      ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      : {
          minX: Math.min(...nodes.map((node) => node.x), ...lanes.map((lane) => lane.x)),
          minY: Math.min(...nodes.map((node) => node.y), ...lanes.map((lane) => lane.y)),
          maxX: Math.max(
            ...nodes.map((node) => node.x + NODE_WIDTH),
            ...lanes.map((lane) => lane.x + lane.width),
            ...gutters.map((gutter) => gutter + LOOP_LABEL_ROOM),
          ),
          maxY: Math.max(
            ...nodes.map((node) => node.y + NODE_HEIGHT),
            ...lanes.map((lane) => lane.y + lane.height),
          ),
        };
  return {
    nodes,
    lanes,
    bounds,
    edges: placed.map(({ gutter: _gutter, ...edge }) => edge),
  };
}
