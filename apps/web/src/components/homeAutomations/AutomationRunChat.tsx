/**
 * A run as its chat: one message per step that ran, in workflow order, with
 * the review loop's passes where the loop sits. A step waiting on you carries
 * approve/reject inline. "Show on workflow" opens the same run on the canvas.
 */
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { WorkflowIcon } from "lucide-react";
import { Fragment } from "react";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { RUN_TRIGGER_LABEL, formatRunTimestamp } from "./automationFormat";
import {
  maxIterations,
  type Automation,
  type AutomationRun,
  type NodeRunResult,
  type WorkflowNode,
} from "./automationModel";
import { runDisplayStatus } from "./automationStatus";
import { RunApprovalActions, awaitsDecision } from "./RunApprovalActions";
import { RunIterations } from "./RunIterations";
import { RunStatusMarker } from "./RunStatusMarker";
import { useAssistantName } from "./useAssistantName";
import { NodeTile, nodeTypeLabel } from "./workflowNodeVisuals";

const HIDDEN_KEYS = new Set(["branch", "draft", "heldMessage", "threadId"]);

/** A one-line readout of a step's output, e.g. "matched: 4 · missing: 2". */
function outputLine(output: unknown) {
  if (output === undefined || output === null) return null;
  if (typeof output !== "object") return String(output);
  const parts = Object.entries(output)
    .filter(([key]) => !HIDDEN_KEYS.has(key))
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function StepMessage(props: { runId: string; node: WorkflowNode; result: NodeRunResult }) {
  const { node, result } = props;
  const nameText = useAssistantName();
  const line = result.error ?? outputLine(result.output);
  return (
    <li className="flex gap-3">
      <NodeTile config={node.config} size="panel" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{nameText(node.title)}</span>
          <span className="text-xs text-muted-foreground">
            {nameText(nodeTypeLabel(node.config))}
          </span>
          {result.durationMs !== undefined ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatDuration(result.durationMs)}
            </span>
          ) : null}
          <RunStatusMarker
            status={
              result.status === "failed"
                ? "failed"
                : result.status === "waiting"
                  ? "approval"
                  : result.status === "running"
                    ? "working"
                    : null
            }
          />
        </div>
        {line ? (
          <p
            className={
              result.error
                ? "text-sm text-pretty text-destructive-foreground"
                : "text-sm text-pretty text-muted-foreground"
            }
          >
            {nameText(line)}
          </p>
        ) : null}
        {awaitsDecision(node, result) ? (
          <RunApprovalActions runId={props.runId} node={node} result={result} />
        ) : null}
      </div>
    </li>
  );
}

export function AutomationRunChat(props: {
  automation: Automation;
  run: AutomationRun;
  onShowOnWorkflow: () => void;
}) {
  const { automation, run } = props;
  const nameText = useAssistantName();
  const ran = automation.nodes.flatMap((node) => {
    const result = run.nodes[node.id];
    return result && result.status !== "skipped" ? [{ node, result }] : [];
  });
  // The loop's passes sit right after the step that decides whether to retry.
  const loopStepId = automation.edges.find((edge) => edge.retry)?.from ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium text-foreground">{nameText(run.title)}</h2>
            <RunStatusMarker status={runDisplayStatus(run)} />
          </span>
          <span className="text-xs text-muted-foreground">
            {RUN_TRIGGER_LABEL[run.trigger]} · {formatRunTimestamp(run)}
            {run.durationMs !== null ? ` · ${formatDuration(run.durationMs)}` : ""}
          </span>
        </div>
        <Button size="xs" variant="ghost" onClick={props.onShowOnWorkflow}>
          <WorkflowIcon />
          Show on workflow
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
          {ran.map(({ node, result }) => (
            <Fragment key={node.id}>
              <StepMessage runId={run.id} node={node} result={result} />
              {run.iterations && node.id === loopStepId ? (
                <li aria-label="Review passes" className="ms-11 rounded-lg border px-3 py-3">
                  <RunIterations
                    iterations={run.iterations}
                    maxIterations={maxIterations(automation.nodes)}
                  />
                </li>
              ) : null}
            </Fragment>
          ))}
        </ol>
      </ScrollArea>
    </div>
  );
}
