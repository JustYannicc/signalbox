/**
 * The workflow's nodes and bezier connectors in canvas coordinates, over
 * optional owner lanes. The canvas transforms this layer for pan and zoom, and
 * it is memoized so dragging the view never re-renders the cards.
 */
import { RepeatIcon, ShieldCheckIcon } from "lucide-react";
import { createElement, memo } from "react";

import { cn } from "~/lib/utils";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  maxIterations,
  nodeOutputs,
  outputFraction,
  type AutomationRun,
  type WorkflowEdge,
  type WorkflowLane,
  type WorkflowNode,
} from "./automationModel";
import { WorkflowNodeCard } from "./WorkflowNodeCard";
import { OWNER_ICON, OWNER_TEXT_CLASS } from "./statusOwnerVisuals";

function outputPoint(node: WorkflowNode, branch: WorkflowEdge["branch"]) {
  return { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT * outputFraction(node.config, branch) };
}

function inputPoint(node: WorkflowNode) {
  return { x: node.x, y: node.y + NODE_HEIGHT / 2 };
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const bend = Math.max(48, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** How far below the lower card a loop-back edge runs. */
const LOOP_DROP = 64;
const LOOP_BEND = 56;

/** A loop-back edge: out to the right, along underneath the graph, into the target from the left. */
function loopPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const bottom = Math.max(from.y, to.y) + NODE_HEIGHT / 2 + LOOP_DROP;
  const out = from.x + LOOP_BEND;
  const back = to.x - LOOP_BEND;
  return [
    `M ${from.x} ${from.y}`,
    `C ${out} ${from.y}, ${out} ${bottom}, ${from.x} ${bottom}`,
    `L ${to.x} ${bottom}`,
    `C ${back} ${bottom}, ${back} ${to.y}, ${to.x} ${to.y}`,
  ].join(" ");
}

function edgeKey(edge: WorkflowEdge) {
  return `${edge.from}-${edge.branch ?? ""}-${edge.to}`;
}

type EdgeTone = "idle" | "taken" | "failed" | "waiting" | "untaken";

function edgeTone(edge: WorkflowEdge, run: AutomationRun | null): EdgeTone {
  if (!run) return "idle";
  const source = run.nodes[edge.from];
  const target = run.nodes[edge.to];
  // A run that looped used its retry edges, even though its last pass exited.
  if ((edge.loop || edge.retry) && (run.iterations?.length ?? 0) > 1) {
    return target && target.status !== "skipped" ? "taken" : "untaken";
  }
  if (source?.status !== "success") return "untaken";
  if (edge.branch && source.output && typeof source.output === "object") {
    const branch = (source.output as { branch?: unknown }).branch;
    if (branch !== edge.branch) return "untaken";
  }
  if (!target || target.status === "skipped") return "untaken";
  if (target.status === "failed") return "failed";
  return target.status === "waiting" ? "waiting" : "taken";
}

const EDGE_STROKE_CLASS: Record<EdgeTone, string> = {
  idle: "stroke-muted-foreground/45",
  taken: "stroke-success/70",
  failed: "stroke-destructive/70",
  waiting: "stroke-warning/70",
  untaken: "stroke-muted-foreground/25",
};

const LANE_TONE_CLASS: Record<WorkflowLane["owner"]["scope"], string> = {
  company: "border-info/16 bg-info/4",
  personal: "border-primary/16 bg-primary/4",
};
const LANE_OVERHANG = 48;

function Lanes(props: { lanes: readonly WorkflowLane[]; nodes: readonly WorkflowNode[] }) {
  if (props.nodes.length === 0) return null;
  const left = Math.min(...props.nodes.map((node) => node.x)) - LANE_OVERHANG;
  const right = Math.max(...props.nodes.map((node) => node.x)) + NODE_WIDTH + LANE_OVERHANG;
  return props.lanes.map((lane) => (
    <div
      key={lane.owner.label}
      className={cn(
        "pointer-events-none absolute rounded-2xl border",
        LANE_TONE_CLASS[lane.owner.scope],
      )}
      style={{ left, top: lane.y, width: right - left, height: lane.height }}
    >
      <span
        className={cn(
          "absolute top-3 left-4 flex items-center gap-1.5 text-xs font-medium",
          OWNER_TEXT_CLASS[lane.owner.scope],
        )}
      >
        {createElement(OWNER_ICON[lane.owner.scope], {
          "aria-hidden": true,
          className: "size-3.5",
        })}
        {lane.owner.label}
      </span>
    </div>
  ));
}

function EdgeLabel(props: {
  label: string;
  boundary: boolean;
  loop: boolean;
  tone: EdgeTone;
  x: number;
  y: number;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-2xs whitespace-nowrap shadow-sm/5",
        props.boundary ? "border-foreground/16 text-foreground" : "text-muted-foreground",
        props.tone === "untaken" && "opacity-60",
      )}
      style={{ left: props.x, top: props.y }}
    >
      {props.boundary ? (
        <ShieldCheckIcon aria-hidden className="size-3 text-success-foreground" />
      ) : props.loop ? (
        <RepeatIcon aria-hidden className="size-3 text-warning-foreground" />
      ) : null}
      {props.label}
    </span>
  );
}

export const WorkflowGraph = memo(function WorkflowGraph(props: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  lanes: readonly WorkflowLane[] | undefined;
  run: AutomationRun | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const nodeById = new Map(props.nodes.map((node) => [node.id, node]));
  const max = maxIterations(props.nodes);
  const loopLabel = max
    ? props.run?.iterations
      ? `iteration ${props.run.iterations.length} / max ${max}`
      : `loops back · max ${max}`
    : "loops back";
  const edges = props.edges.flatMap((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return [];
    const start = outputPoint(from, edge.branch);
    const end = inputPoint(to);
    const branchLabel =
      nodeOutputs(from.config)?.find((output) => output.key === edge.branch)?.label ?? null;
    const tone = edgeTone(edge, props.run);
    if (edge.loop) {
      const bottom = Math.max(start.y, end.y) + NODE_HEIGHT / 2 + LOOP_DROP;
      const middle = { x: (start.x + end.x) / 2, y: bottom };
      return [
        { edge, start, middle, branchLabel, tone, path: loopPath(start, end), label: loopLabel },
      ];
    }
    // The cubic's midpoint is the plain average because its bends are symmetric.
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const path = edgePath(start, end);
    return [{ edge, start, middle, branchLabel, tone, path, label: edge.label ?? null }];
  });

  return (
    <>
      {props.lanes ? <Lanes lanes={props.lanes} nodes={props.nodes} /> : null}
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width={1}
        height={1}
      >
        {edges.map(({ edge, path, tone }) => (
          <path
            key={edgeKey(edge)}
            d={path}
            fill="none"
            strokeWidth={tone === "idle" || tone === "untaken" ? 1.5 : 2}
            strokeLinecap="round"
            {...(tone === "untaken" ? { strokeDasharray: "4 5" } : {})}
            className={EDGE_STROKE_CLASS[tone]}
          />
        ))}
      </svg>
      {edges.map(({ edge, middle, tone, label }) =>
        label ? (
          <EdgeLabel
            key={`${edgeKey(edge)}-mid`}
            label={label}
            boundary={edge.boundary ?? false}
            loop={edge.loop ?? false}
            tone={tone}
            x={middle.x}
            y={middle.y}
          />
        ) : null,
      )}
      {edges.map(({ edge, start, branchLabel: label, tone }) => {
        if (!label) return null;
        return (
          <span
            key={`${edgeKey(edge)}-label`}
            className={cn(
              "pointer-events-none absolute -translate-y-1/2 rounded-full border bg-background px-1.5 py-px text-3xs whitespace-nowrap",
              tone === "untaken" ? "text-muted-foreground/60" : "text-muted-foreground",
            )}
            style={{ left: start.x + 14, top: start.y }}
          >
            {label}
          </span>
        );
      })}
      {props.nodes.map((node) => (
        <WorkflowNodeCard
          key={node.id}
          node={node}
          result={props.run?.nodes[node.id] ?? null}
          runSelected={props.run !== null}
          selected={props.selectedNodeId === node.id}
          onSelect={props.onSelectNode}
        />
      ))}
    </>
  );
});
