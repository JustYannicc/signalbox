/**
 * The messages of a run's chat: one per step that ran, and one per loop with
 * its passes. A step says what it is, how long it took, how it went and what
 * it came back with in a line; a waiting question carries its answer buttons,
 * and an agent step links to the thread that did the work.
 */
import {
  workflowNodeIdForStepKey,
  type AutomationStep,
  type EnvironmentId,
  type WorkflowGraph,
  type WorkflowStepNode,
} from "@t3tools/contracts";
import { questionFromStep } from "@t3tools/client-runtime/automations/ask";
import {
  CONTAINER_TYPE_LABEL,
  durationMs,
  stepTypeLabel,
} from "@t3tools/client-runtime/automations/labels";
import {
  findWorkflowNode,
  passSummary,
  resultLine,
  type RunPass,
} from "@t3tools/client-runtime/automations/runs";
import { stepDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { ChevronRightIcon, RepeatIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { AskAnswer } from "./AskAnswer";
import { StepTile } from "./nodeVisuals";
import { ErrorHelp } from "./RunDiagnostics";
import { RunStatusMarker } from "./RunStatus";
import { AgentThreadButton } from "./StepRunList";

/** Passes shown before "Show all"; an `each` over hundreds of items stays cheap. */
const PASS_PREVIEW_COUNT = 10;

function stepNode(graph: WorkflowGraph, step: AutomationStep): WorkflowStepNode | null {
  const node = findWorkflowNode(graph.nodes, workflowNodeIdForStepKey(step.key));
  return node?.type === "step" ? node : null;
}

function Meta(props: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{props.children}</span>;
}

export function StepMessage(props: {
  environmentId: EnvironmentId;
  runId: string;
  graph: WorkflowGraph;
  step: AutomationStep;
}) {
  const { step } = props;
  const node = stepNode(props.graph, step) ?? { verb: step.verb };
  const ms = durationMs(step);
  const question = questionFromStep(props.runId, step);
  const line = step.error ?? (question ? null : resultLine(step.result));
  return (
    <li className="flex gap-3">
      <StepTile node={node} size="panel" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium break-words text-foreground">{step.label}</span>
          <Meta>{stepTypeLabel(node)}</Meta>
          {ms !== null ? <Meta>{formatDuration(ms)}</Meta> : null}
          <RunStatusMarker status={stepDisplayStatus(step)} />
        </div>
        {line ? (
          <p
            className={cn(
              "text-sm text-pretty break-words",
              step.error ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {line}
          </p>
        ) : null}
        {step.error ? <ErrorHelp detail={step.errorDetail} /> : null}
        {question ? (
          <AskAnswer environmentId={props.environmentId} question={question} showTitle={false} />
        ) : null}
        <AgentThreadButton environmentId={props.environmentId} step={step} />
      </div>
    </li>
  );
}

/** A pass needs to stay open when something in it is waiting on you or failed. */
function passNeedsLook(pass: RunPass) {
  return pass.steps.some((step) => step.status === "failed" || step.status === "waiting");
}

function PassRow(props: {
  pass: RunPass;
  max: number | undefined;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const summary = passSummary(props.pass);
  return (
    <li className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="-mx-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            props.open && "rotate-90",
          )}
        />
        <span className="shrink-0 text-xs font-medium text-foreground">
          Pass {props.pass.index + 1}
          {props.max ? ` / ${props.max}` : ""}
        </span>
        <RunStatusMarker status={stepDisplayStatus(summary.step)} />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {props.open ? null : summary.line}
        </span>
        {summary.durationMs !== null ? <Meta>{formatDuration(summary.durationMs)}</Meta> : null}
      </button>
      {props.open ? <ol className="flex flex-col gap-4 ps-5">{props.children}</ol> : null}
    </li>
  );
}

export function LoopMessage(props: {
  environmentId: EnvironmentId;
  runId: string;
  graph: WorkflowGraph;
  nodeId: string;
  passes: ReadonlyArray<RunPass>;
}) {
  const node = findWorkflowNode(props.graph.nodes, props.nodeId);
  const loop = node?.type === "loop" ? node : null;
  const [toggled, setToggled] = useState<ReadonlySet<number>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? props.passes : props.passes.slice(0, PASS_PREVIEW_COUNT);
  const last = props.passes.at(-1)?.index;
  // Few passes read best open; many start folded except the ones worth a look.
  const openByDefault = (pass: RunPass) =>
    props.passes.length <= 3 || pass.index === last || passNeedsLook(pass);

  return (
    <li className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80">
        <RepeatIcon aria-hidden className="size-4.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium break-words text-foreground">
            {loop?.label.text ?? "Loop"}
          </span>
          <Meta>{loop ? CONTAINER_TYPE_LABEL[loop.verb] : "Loop"}</Meta>
          <Meta>{props.passes.length === 1 ? "1 pass" : `${props.passes.length} passes`}</Meta>
        </div>
        <ol aria-label="Passes" className="flex flex-col gap-3 rounded-lg border px-3 py-3">
          {shown.map((pass) => {
            const open = openByDefault(pass) !== toggled.has(pass.index);
            return (
              <PassRow
                key={pass.index}
                pass={pass}
                max={loop?.verb === "repeat" ? loop.max : undefined}
                open={open}
                onToggle={() =>
                  setToggled((current) => {
                    const next = new Set(current);
                    if (!next.delete(pass.index)) next.add(pass.index);
                    return next;
                  })
                }
              >
                {pass.steps.map((step) => (
                  <StepMessage
                    key={step.key}
                    environmentId={props.environmentId}
                    runId={props.runId}
                    graph={props.graph}
                    step={step}
                  />
                ))}
              </PassRow>
            );
          })}
          {props.passes.length > PASS_PREVIEW_COUNT ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
              >
                {showAll ? "Show less" : `Show ${props.passes.length - PASS_PREVIEW_COUNT} more`}
              </button>
            </li>
          ) : null}
        </ol>
      </div>
    </li>
  );
}
