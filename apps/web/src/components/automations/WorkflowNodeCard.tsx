/**
 * One workflow step on the canvas: icon tile, type label, title, and the
 * input/output handles its edges attach to. Owned steps carry an owner pill on
 * the top edge. With a run selected it also shows how that step went.
 */
import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  isTriggerNode,
  nodeOutputs,
  outputFraction,
  type NodeRunResult,
  type WorkflowNode,
} from "./automationModel";
import { RUN_STATUS_LABEL } from "./automationFormat";
import { NodeTile, nodeTypeLabel } from "./workflowNodeVisuals";
import { useAssistantName } from "./useAssistantName";
import { NODE_STATUS_BADGE_CLASS, NodeStatusIcon, OwnerPill } from "./statusOwnerVisuals";

/** `fraction` is the handle's height on the card, the same one edges attach at. */
function Handle(props: { side: "in" | "out"; fraction?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute size-2.5 -translate-y-1/2 rounded-full border border-muted-foreground/50 bg-card",
        props.side === "in" ? "-left-1.25" : "-right-1.25",
      )}
      style={{ top: `${(props.fraction ?? 0.5) * 100}%` }}
    />
  );
}

function OutputHandles({ config }: { config: WorkflowNode["config"] }) {
  // Verdicts end the workflow: the intercepted request is allowed, held, or blocked.
  if (config.kind === "verdict") return null;
  const outputs = nodeOutputs(config);
  if (!outputs) return <Handle side="out" />;
  return outputs.map((output) => (
    <Handle key={output.key} side="out" fraction={outputFraction(config, output.key)} />
  ));
}

export const WorkflowNodeCard = memo(function WorkflowNodeCard(props: {
  node: WorkflowNode;
  /** Null when no run is selected, or the run never reached this step. */
  result: NodeRunResult | null;
  runSelected: boolean;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const { node, result } = props;
  const nameText = useAssistantName();
  const status = result?.status ?? null;
  const notReached = props.runSelected && (status === null || status === "skipped");

  return (
    <button
      type="button"
      data-workflow-node
      aria-pressed={props.selected}
      aria-label={`${node.title}${node.owner ? `, ${node.owner.label}` : ""}${status ? `, ${RUN_STATUS_LABEL[status]}` : ""}`}
      onClick={() => props.onSelect(node.id)}
      className={cn(
        "group/node absolute flex cursor-pointer items-center gap-3 rounded-xl border bg-card px-3 text-left shadow-sm/5 outline-none transition-[border-color,box-shadow,opacity] duration-150 hover:border-foreground/24 focus-visible:ring-2 focus-visible:ring-ring",
        props.selected
          ? "border-primary ring-3 ring-primary/16"
          : status === "failed"
            ? "border-destructive/60"
            : status === "waiting"
              ? "border-warning/60"
              : status === "success"
                ? "border-success/40"
                : "border-border",
        notReached && !props.selected && "border-dashed opacity-60",
      )}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <NodeTile config={node.config} size="card" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-2xs text-muted-foreground">
          {nameText(nodeTypeLabel(node.config))}
        </span>
        <span className="truncate text-sm font-medium text-foreground">{nameText(node.title)}</span>
      </span>
      {node.owner ? <OwnerPill owner={node.owner} className="absolute -top-2 left-3" /> : null}
      {status ? (
        <span
          aria-hidden
          className={cn(
            "absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full ring-2 ring-background",
            NODE_STATUS_BADGE_CLASS[status],
          )}
        >
          <NodeStatusIcon status={status} className="size-3" />
        </span>
      ) : null}
      {isTriggerNode(node.config) ? null : <Handle side="in" />}
      <OutputHandles config={node.config} />
    </button>
  );
});
