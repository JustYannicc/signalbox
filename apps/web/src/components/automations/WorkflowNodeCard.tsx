/**
 * One workflow step on the canvas: icon tile, type label, title, and the
 * output handles its edges leave from (inputs are marked by the incoming
 * arrowheads on the top edge). Owned steps carry an owner badge on the top-left
 * corner; the lane column names the owner. With a run selected it also shows
 * how that step went.
 */
import { createElement, memo } from "react";

import { cn } from "~/lib/utils";
import { NODE_HEIGHT, NODE_WIDTH, type NodeRunResult, type WorkflowNode } from "./automationModel";
import { RUN_STATUS_LABEL } from "./automationFormat";
import { NodeTile, nodeTypeLabel } from "./workflowNodeVisuals";
import { useAssistantName } from "./useAssistantName";
import {
  NODE_STATUS_BADGE_CLASS,
  NodeStatusIcon,
  OWNER_ICON,
  OWNER_TEXT_CLASS,
} from "./statusOwnerVisuals";
import { outputAnchors } from "./workflowLayout";

/** Output handles sit where `outputAnchors` says, the same points edges leave from. */
function OutputHandles({ config }: { config: WorkflowNode["config"] }) {
  return outputAnchors(config).map((anchor) => (
    <span
      key={anchor.key ?? "out"}
      aria-hidden
      className="pointer-events-none absolute size-2.5 -translate-1/2 rounded-full border border-muted-foreground/50 bg-card"
      style={{ left: anchor.at.x, top: anchor.at.y }}
    />
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
      {node.owner ? (
        <span
          aria-hidden
          className={cn(
            "absolute -top-2 -left-2 flex size-5 items-center justify-center rounded-full border bg-card ring-2 ring-background",
            OWNER_TEXT_CLASS[node.owner.scope],
          )}
        >
          {createElement(OWNER_ICON[node.owner.scope], { className: "size-3" })}
        </span>
      ) : null}
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
      <OutputHandles config={node.config} />
    </button>
  );
});
