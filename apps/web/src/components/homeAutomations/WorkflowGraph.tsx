/**
 * Draws a laid-out workflow top to bottom: owner lanes as columns, then the
 * connectors with their labels, then the cards. The canvas transforms this
 * layer for pan and zoom, and it is memoized so dragging the view never
 * re-renders the cards. Geometry comes from `verticalLayout`.
 */
import { RepeatIcon, ShieldCheckIcon } from "lucide-react";
import { createElement, memo } from "react";

import { cn } from "~/lib/utils";
import {
  maxIterations,
  type AutomationRun,
  type WorkflowEdge,
  type NodeOwner,
} from "./automationModel";
import { WorkflowNodeCard } from "./WorkflowNodeCard";
import { OWNER_ICON, OWNER_TEXT_CLASS } from "./statusOwnerVisuals";
import type { PlacedLane, WorkflowLayout } from "./workflowLayout";

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

const LANE_TONE_CLASS: Record<NodeOwner["scope"], string> = {
  company: "border-info/16 bg-info/4",
  personal: "border-primary/16 bg-primary/4",
};

function Lanes(props: { lanes: readonly PlacedLane[] }) {
  return props.lanes.map((lane) => (
    <div
      key={lane.owner.label}
      className={cn(
        "pointer-events-none absolute rounded-2xl border",
        LANE_TONE_CLASS[lane.owner.scope],
      )}
      style={{ left: lane.x, top: lane.y, width: lane.width, height: lane.height }}
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

const EDGE_FILL_CLASS: Record<EdgeTone, string> = {
  idle: "fill-muted-foreground/45",
  taken: "fill-success/70",
  failed: "fill-destructive/70",
  waiting: "fill-warning/70",
  untaken: "fill-muted-foreground/25",
};
const EDGE_TONES = Object.keys(EDGE_STROKE_CLASS) as EdgeTone[];

export const WorkflowGraph = memo(function WorkflowGraph(props: {
  layout: WorkflowLayout;
  run: AutomationRun | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { layout } = props;
  const max = maxIterations(layout.nodes);
  const loopLabel = max
    ? props.run?.iterations
      ? `iteration ${props.run.iterations.length} / max ${max}`
      : `loops back · max ${max}`
    : "loops back";
  const edges = layout.edges.map((placed) => ({
    ...placed,
    tone: edgeTone(placed.edge, props.run),
    label: placed.edge.loop ? loopLabel : (placed.edge.label ?? null),
  }));

  return (
    <>
      <Lanes lanes={layout.lanes} />
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width={1}
        height={1}
      >
        <defs>
          {EDGE_TONES.map((tone) => (
            <marker
              key={tone}
              id={`workflow-arrow-${tone}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M 0 0.5 L 7.5 4 L 0 7.5 z" className={EDGE_FILL_CLASS[tone]} />
            </marker>
          ))}
        </defs>
        {edges.map(({ key, path, tone }) => (
          <path
            key={key}
            d={path}
            fill="none"
            strokeWidth={tone === "idle" || tone === "untaken" ? 1.5 : 2}
            strokeLinecap="round"
            {...(tone === "untaken" ? { strokeDasharray: "4 5" } : {})}
            className={EDGE_STROKE_CLASS[tone]}
            markerEnd={`url(#workflow-arrow-${tone})`}
          />
        ))}
      </svg>
      {edges.map(({ edge, key, middle, tone, label }) =>
        label ? (
          <EdgeLabel
            key={`${key}-mid`}
            label={label}
            boundary={edge.boundary ?? false}
            loop={edge.loop ?? false}
            tone={tone}
            x={middle.x}
            y={middle.y}
          />
        ) : null,
      )}
      {edges.map(({ key, branchAt, branchLabel, tone }) =>
        branchLabel ? (
          <span
            key={`${key}-branch`}
            className={cn(
              "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-1.5 py-px text-3xs whitespace-nowrap",
              tone === "untaken" ? "text-muted-foreground/60" : "text-muted-foreground",
            )}
            style={{ left: branchAt.x, top: branchAt.y }}
          >
            {branchLabel}
          </span>
        ) : null,
      )}
      {layout.nodes.map((node) => (
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
