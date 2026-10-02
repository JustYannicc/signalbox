/**
 * Inline panel beside the canvas for the selected node: what the step is
 * configured to do and, with a run selected, what it did in that run. A step
 * waiting on you (approval, or a held message) offers approve/reject.
 * Read-only until automations can be edited.
 */
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { XIcon } from "lucide-react";

import type { ThreadDisplayStatus } from "../threadStatusDisplay";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import {
  type AutomationRun,
  type NodeRunResult,
  type NodeRunStatus,
  type WorkflowNode,
} from "./automationModel";
import { RUN_STATUS_LABEL } from "./automationFormat";
import { CodeBlock, Field, Section } from "./nodeDetailsParts";
import { RunApprovalActions, awaitsDecision } from "./RunApprovalActions";
import { RunStatusMarker } from "./RunStatusMarker";
import { useAssistantName } from "./useAssistantName";
import { ConfigFields } from "./WorkflowNodeConfigFields";
import { NodeExtraSections } from "./WorkflowNodeExtraSections";
import { RunIterations } from "./RunIterations";
import { NodeTile, nodeTypeLabel } from "./workflowNodeVisuals";
import { OwnerPill } from "./statusOwnerVisuals";

/** Steps use the same markers as runs; finished and skipped steps get plain text. */
const STEP_DISPLAY_STATUS = {
  failed: "failed",
  waiting: "approval",
  running: "working",
  success: null,
  skipped: null,
} as const satisfies Record<NodeRunStatus, ThreadDisplayStatus | null>;

function RunResult(props: {
  node: WorkflowNode;
  run: AutomationRun;
  result: NodeRunResult | null;
}) {
  const { result } = props;
  if (!result) {
    return (
      <p className="text-sm text-muted-foreground">
        {props.run.status === "running"
          ? "Waiting on earlier steps."
          : props.run.status === "waiting"
            ? "Runs after your decision."
            : "This step never ran."}
      </p>
    );
  }
  const awaiting = awaitsDecision(props.node, result);
  const displayStatus = STEP_DISPLAY_STATUS[result.status];
  return (
    <dl className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {displayStatus ? (
          <RunStatusMarker status={displayStatus} />
        ) : (
          <span className="text-xs text-muted-foreground">{RUN_STATUS_LABEL[result.status]}</span>
        )}
        {result.durationMs !== undefined ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDuration(result.durationMs)}
          </span>
        ) : null}
      </div>
      {result.error ? (
        <Field label="Error">
          <CodeBlock tone="error">{result.error}</CodeBlock>
        </Field>
      ) : null}
      {awaiting ? (
        <RunApprovalActions runId={props.run.id} node={props.node} result={result} />
      ) : result.input !== undefined ? (
        <Field label="Input">
          <CodeBlock>{JSON.stringify(result.input, null, 2)}</CodeBlock>
        </Field>
      ) : null}
      {result.output !== undefined ? (
        <Field label="Output">
          <CodeBlock>{JSON.stringify(result.output, null, 2)}</CodeBlock>
        </Field>
      ) : null}
    </dl>
  );
}

/** Steps inside a review loop show every pass of it, not just the last. */
function isLoopStep(node: WorkflowNode) {
  const { kind } = node.config;
  return kind === "agent" || kind === "judge" || kind === "gate";
}

export function WorkflowNodeDetails(props: {
  node: WorkflowNode;
  run: AutomationRun | null;
  /** From the workflow's gate, when it has one. */
  maxIterations: number | null;
  onClose: () => void;
}) {
  const { node, run } = props;
  const nameText = useAssistantName();

  return (
    <aside
      aria-label={`${node.title} details`}
      className="flex w-80 shrink-0 flex-col border-l bg-card"
    >
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <NodeTile config={node.config} size="panel" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs text-muted-foreground">
            {nameText(nodeTypeLabel(node.config))}
          </span>
          <h2 className="text-sm font-medium text-balance text-foreground">
            {nameText(node.title)}
          </h2>
          {node.owner ? <OwnerPill owner={node.owner} className="mt-1 self-start" /> : null}
        </div>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Close details"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {run ? (
          <Section title="This run">
            <RunResult node={node} run={run} result={run.nodes[node.id] ?? null} />
          </Section>
        ) : null}
        {run?.iterations && isLoopStep(node) ? (
          <Section title="Iterations">
            <RunIterations iterations={run.iterations} maxIterations={props.maxIterations} />
          </Section>
        ) : null}
        <Section title="Configuration">
          <dl className="flex flex-col gap-3">
            <ConfigFields config={node.config} />
          </dl>
        </Section>
        <NodeExtraSections config={node.config} />
      </ScrollArea>
    </aside>
  );
}
