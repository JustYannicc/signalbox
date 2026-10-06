import type {
  WorkflowArm,
  WorkflowBranchNode,
  WorkflowGraph,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowStepNode,
  WorkflowTryNode,
} from "@t3tools/contracts";

/**
 * Lays an automation's graph out top to bottom. The graph is a tree that
 * mirrors the code, so this is a recursive box layout, not a general graph
 * layout: sequences stack, decisions fan out into side-by-side arms that
 * rejoin below, and loops, parallel groups and try blocks are containers.
 * Positions are plain numbers so web (HTML + SVG) and mobile (react-native-svg)
 * draw the same picture.
 */

export const LAYOUT = {
  cardWidth: 248,
  cardHeight: 60,
  decisionHeight: 52,
  endWidth: 72,
  endHeight: 26,
  triggerHeight: 44,
  rowGap: 36,
  columnGap: 28,
  containerPadding: 18,
  containerHeader: 34,
  armLabelGap: 22,
} as const;

export type LayoutCard =
  | {
      readonly kind: "trigger";
      readonly id: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly label: string;
    }
  | {
      readonly kind: "step";
      readonly id: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly node: WorkflowStepNode;
    }
  | {
      readonly kind: "decision";
      readonly id: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly node: WorkflowBranchNode;
    }
  | {
      readonly kind: "end";
      readonly id: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly done: boolean;
    };

export interface LayoutContainer {
  readonly id: string;
  readonly kind: "each" | "repeat" | "for" | "while" | "parallel" | "try";
  readonly label: string;
  /** "up to 3 times", "4 at a time". */
  readonly detail: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEdge {
  readonly id: string;
  /** Orthogonal polyline, top to bottom. */
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** The card or box whose bottom the edge leaves; null when it starts mid-air, below a join. */
  readonly from: string | null;
  /** The card or box whose top the edge enters; null when it ends mid-air (a join, an empty option). */
  readonly to: string | null;
  /** The option this edge takes out of a decision, try block or parallel group. */
  readonly arm: { readonly decisionId: string; readonly index: number } | null;
  /** The option this edge takes out of a decision or into a parallel branch. */
  readonly label: string | null;
  readonly labelAt: { readonly x: number; readonly y: number } | null;
  /** The first card or container the edge leads into; the edge was taken when that ran. */
  readonly via: ReadonlyArray<string>;
  /** Edges into "if it fails" paths are drawn dashed. */
  readonly failure: boolean;
}

export interface WorkflowLayout {
  readonly width: number;
  readonly height: number;
  readonly cards: ReadonlyArray<LayoutCard>;
  readonly containers: ReadonlyArray<LayoutContainer>;
  readonly edges: ReadonlyArray<LayoutEdge>;
}

/** A laid-out block in its own coordinates: top-left at 0,0, entry and exit on the `axis` column. */
interface Block {
  width: number;
  height: number;
  axis: number;
  /** False when the block always ends the run or callback, so nothing continues below it. */
  open: boolean;
  /** The card or box at the top of the axis, which an edge into the block enters. */
  entry: string | null;
  /** The card or box at the bottom of the axis, which an edge out of the block leaves. */
  exit: string | null;
  /** Graph node ids inside the block, for edge highlighting. */
  ids: string[];
  cards: LayoutCard[];
  containers: LayoutContainer[];
  edges: LayoutEdge[];
}

const point = (x: number, y: number) => ({ x, y });

function shift(block: Block, dx: number, dy: number): Block {
  return {
    ...block,
    cards: block.cards.map((card) => ({ ...card, x: card.x + dx, y: card.y + dy })),
    containers: block.containers.map((container) => ({
      ...container,
      x: container.x + dx,
      y: container.y + dy,
    })),
    edges: block.edges.map((edge) => ({
      ...edge,
      points: edge.points.map((p) => point(p.x + dx, p.y + dy)),
      labelAt: edge.labelAt ? point(edge.labelAt.x + dx, edge.labelAt.y + dy) : null,
    })),
  };
}

/** A vertical line, or a dog-leg when the two ends sit on different columns. */
function connector(
  id: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ends: Pick<LayoutEdge, "from" | "to">,
  extra: Partial<LayoutEdge> = {},
): LayoutEdge {
  const points =
    from.x === to.x
      ? [from, to]
      : [
          from,
          point(from.x, from.y + LAYOUT.rowGap / 2),
          point(to.x, from.y + LAYOUT.rowGap / 2),
          to,
        ];
  return {
    id,
    points,
    ...ends,
    arm: null,
    label: null,
    labelAt: null,
    via: [],
    failure: false,
    ...extra,
  };
}

function empty(): Block {
  return {
    width: LAYOUT.cardWidth,
    height: 0,
    axis: LAYOUT.cardWidth / 2,
    open: true,
    entry: null,
    exit: null,
    ids: [],
    cards: [],
    containers: [],
    edges: [],
  };
}

function single(card: LayoutCard, open = true): Block {
  return {
    width: card.width,
    height: card.height,
    axis: card.width / 2,
    open,
    entry: card.id,
    exit: card.id,
    ids: [card.id],
    cards: [card],
    containers: [],
    edges: [],
  };
}

/** Stacks blocks on one axis, joining each exit to the next entry. */
function sequence(id: string, blocks: ReadonlyArray<Block>): Block {
  if (blocks.length === 0) return empty();
  const left = Math.max(...blocks.map((block) => block.axis));
  const right = Math.max(...blocks.map((block) => block.width - block.axis));
  const result: Block = {
    width: left + right,
    height: 0,
    axis: left,
    open: true,
    entry: blocks[0]!.entry,
    exit: null,
    ids: [],
    cards: [],
    containers: [],
    edges: [],
  };
  let y = 0;
  blocks.forEach((block, index) => {
    if (index > 0) {
      if (result.open && block.height > 0) {
        result.edges.push(
          connector(`${id}:seq:${index}`, point(left, y), point(left, y + LAYOUT.rowGap), {
            from: result.exit,
            to: block.entry,
          }),
        );
      }
      y += LAYOUT.rowGap;
    }
    const placed = shift(block, left - block.axis, y);
    result.cards.push(...placed.cards);
    result.containers.push(...placed.containers);
    result.edges.push(...placed.edges);
    result.ids.push(...placed.ids);
    y += block.height;
    // Steps after an unconditional end can't run; drawing them disconnected is still useful.
    result.open = block.open;
    result.exit = block.exit;
  });
  result.height = y;
  return result;
}

/**
 * Arms side by side under a header card. Open arms rejoin on the axis
 * below; arms that end the run stop where they are.
 */
function fanOut(
  id: string,
  header: Block,
  arms: ReadonlyArray<{ label: string; block: Block; failure?: boolean }>,
  rejoin: boolean,
): Block {
  const widths = arms.map((arm) => Math.max(arm.block.width, LAYOUT.cardWidth * 0.6));
  const totalArms =
    widths.reduce((sum, width) => sum + width, 0) + LAYOUT.columnGap * Math.max(0, arms.length - 1);
  const width = Math.max(header.width, totalArms);
  const axis = width / 2;
  const result: Block = {
    width,
    height: 0,
    axis,
    open: false,
    entry: header.entry,
    exit: null,
    ids: [],
    cards: [],
    containers: [],
    edges: [],
  };
  const placedHeader = shift(header, axis - header.axis, 0);
  result.cards.push(...placedHeader.cards);
  result.containers.push(...placedHeader.containers);
  result.edges.push(...placedHeader.edges);
  result.ids.push(...placedHeader.ids);

  const armTop = header.height + LAYOUT.rowGap + LAYOUT.armLabelGap;
  let x = (width - totalArms) / 2;
  const bottoms: { x: number; y: number; exit: string | null; ids: string[] }[] = [];
  arms.forEach((arm, index) => {
    const armAxis = x + Math.max(arm.block.axis, widths[index]! / 2);
    const start = point(axis, header.height);
    const placed = shift(arm.block, armAxis - arm.block.axis, armTop);
    const entryY = arm.block.height > 0 ? armTop : armTop - LAYOUT.armLabelGap / 2;
    result.edges.push(
      connector(
        `${id}:arm:${index}`,
        start,
        point(armAxis, entryY),
        { from: header.exit, to: arm.block.entry },
        {
          arm: { decisionId: id, index },
          label: arm.label || null,
          labelAt: arm.label ? point(armAxis, header.height + LAYOUT.rowGap) : null,
          via: arm.block.ids.slice(0, 1),
          failure: arm.failure ?? false,
        },
      ),
    );
    result.cards.push(...placed.cards);
    result.containers.push(...placed.containers);
    result.edges.push(...placed.edges);
    result.ids.push(...placed.ids);
    if (arm.block.open)
      bottoms.push({
        x: armAxis,
        y: entryY + arm.block.height,
        exit: arm.block.exit,
        ids: arm.block.ids,
      });
    x += widths[index]! + LAYOUT.columnGap;
  });

  const lowest = Math.max(armTop, ...arms.map((arm) => armTop + arm.block.height));
  if (rejoin && bottoms.length > 0) {
    const joinY = lowest + LAYOUT.rowGap / 2;
    bottoms.forEach((bottom, index) => {
      result.edges.push(
        connector(
          `${id}:join:${index}`,
          point(bottom.x, bottom.y),
          point(axis, joinY),
          { from: bottom.exit, to: null },
          { via: bottom.ids.slice(-1) },
        ),
      );
    });
    result.height = joinY;
    result.open = true;
  } else {
    // Every arm ends the run, so nothing continues below the decision.
    result.height = lowest;
    result.open = !rejoin;
  }
  return result;
}

/** Wraps a block in a labelled container box. */
function contain(
  id: string,
  kind: LayoutContainer["kind"],
  label: string,
  detail: string | null,
  inner: Block,
): Block {
  const pad = LAYOUT.containerPadding;
  const width = Math.max(inner.width + pad * 2, LAYOUT.cardWidth + pad * 2);
  const height = LAYOUT.containerHeader + inner.height + pad;
  const placed = shift(inner, width / 2 - inner.axis, LAYOUT.containerHeader);
  return {
    width,
    height,
    axis: width / 2,
    open: true,
    entry: id,
    exit: id,
    ids: [id, ...placed.ids],
    cards: placed.cards,
    containers: [{ id, kind, label, detail, x: 0, y: 0, width, height }, ...placed.containers],
    edges: placed.edges,
  };
}

function loopDetail(node: WorkflowLoopNode) {
  if (node.verb === "repeat" && node.max) return `up to ${node.max} times`;
  if (node.verb === "each" && node.concurrency && node.concurrency > 1)
    return `${node.concurrency} at a time`;
  if (node.verb === "each") return "one at a time";
  return null;
}

function layoutNodes(prefix: string, nodes: ReadonlyArray<WorkflowNode>): Block {
  return sequence(prefix, nodes.map(layoutNode));
}

function layoutArms(ownerId: string, arms: ReadonlyArray<WorkflowArm>) {
  return arms.map((arm, index) => ({
    label: arm.label || "Otherwise",
    block: layoutNodes(`${ownerId}:arm${index}`, arm.body),
  }));
}

function layoutNode(node: WorkflowNode): Block {
  switch (node.type) {
    case "step":
      return single({
        kind: "step",
        id: node.id,
        x: 0,
        y: 0,
        width: LAYOUT.cardWidth,
        height: LAYOUT.cardHeight,
        node,
      });
    case "end":
      return single(
        {
          kind: "end",
          id: node.id,
          x: 0,
          y: 0,
          width: LAYOUT.endWidth,
          height: LAYOUT.endHeight,
          done: node.done ?? false,
        },
        false,
      );
    case "branch": {
      const header = single({
        kind: "decision",
        id: node.id,
        x: 0,
        y: 0,
        width: LAYOUT.cardWidth,
        height: LAYOUT.decisionHeight,
        node,
      });
      return fanOut(node.id, header, layoutArms(node.id, node.arms), true);
    }
    case "loop":
      return contain(
        node.id,
        node.verb,
        node.label.text,
        loopDetail(node),
        layoutNodes(node.id, node.body),
      );
    case "parallel": {
      const inner = fanOut(node.id, empty(), layoutArms(node.id, node.branches), true);
      return contain(
        node.id,
        "parallel",
        node.label.text,
        `${node.branches.length} at the same time`,
        inner,
      );
    }
    case "try":
      return layoutTry(node);
  }
}

function layoutTry(node: WorkflowTryNode): Block {
  const inner = fanOut(
    node.id,
    empty(),
    [
      { label: "", block: layoutNodes(`${node.id}:body`, node.body) },
      {
        label: "If it fails",
        block: layoutNodes(`${node.id}:failure`, node.failure),
        failure: true,
      },
    ],
    true,
  );
  return contain(node.id, "try", node.label.text, null, inner);
}

/** Lays out the whole automation under a trigger card such as "Every hour". */
export function layoutWorkflow(graph: WorkflowGraph, trigger: string): WorkflowLayout {
  const start = single({
    kind: "trigger",
    id: "trigger",
    x: 0,
    y: 0,
    width: LAYOUT.cardWidth,
    height: LAYOUT.triggerHeight,
    label: trigger,
  });
  const body = sequence("root", [start, ...graph.nodes.map(layoutNode)]);
  const margin = LAYOUT.containerPadding;
  const placed = shift(body, margin, margin);
  return {
    width: body.width + margin * 2,
    height: body.height + margin * 2,
    cards: placed.cards,
    containers: placed.containers,
    edges: placed.edges,
  };
}
