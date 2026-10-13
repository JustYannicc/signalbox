/**
 * What one diagram node did in a run: each of its steps (a loop runs a node
 * many times) with status, duration, error and result, a way into the agent
 * thread that did the work, and the answer buttons for a waiting question.
 */
import {
  workflowStepKeyCall,
  workflowStepKeyFrames,
  type AutomationStep,
  type EnvironmentId,
} from "@t3tools/contracts";
import { questionFromStep } from "@t3tools/client-runtime/automations/ask";
import {
  agentThreadId,
  compactJson,
  durationMs,
  hiddenPassesLabel,
} from "@t3tools/client-runtime/automations/labels";
import { stepDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { AskAnswer } from "./AskAnswer";
import { ErrorHelp } from "./RunDiagnostics";
import { StatusLabel } from "./RunStatus";

/** Most recent steps shown per node; a long loop keeps the panel cheap. */
const MAX_STEPS = 20;

export function CodeBlock(props: { children: ReactNode; tone?: "error" }) {
  return (
    <pre
      className={
        props.tone === "error"
          ? "max-h-48 overflow-auto rounded-md bg-destructive/8 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-destructive-foreground"
          : "max-h-48 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-foreground"
      }
    >
      {props.children}
    </pre>
  );
}

/** Opens the agent thread that did a step's work. Nothing for steps that don't run in one. */
export function AgentThreadButton(props: {
  environmentId: EnvironmentId;
  step: Pick<AutomationStep, "verb" | "threadId">;
}) {
  const threadId = agentThreadId(props.step);
  if (!threadId) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      className="self-start"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: props.environmentId, threadId }}
        />
      }
    >
      <MessageSquareIcon />
      Open agent thread
    </Button>
  );
}

/** "pass 2.3, call 2": tells a step's loop passes and repeated calls apart. */
function iterationLabel(key: string): string | null {
  const passes = workflowStepKeyFrames(key).map((frame) => frame.pass + 1);
  const call = workflowStepKeyCall(key);
  const parts = [
    ...(passes.length > 0 ? [`pass ${passes.join(".")}`] : []),
    ...(call !== null ? [`call ${call}`] : []),
  ];
  return parts.length > 0 ? parts.join(", ") : null;
}

function StepRun(props: { environmentId: EnvironmentId; runId: string; step: AutomationStep }) {
  const { step } = props;
  const ms = durationMs(step);
  const iteration = iterationLabel(step.key);
  const question = questionFromStep(props.runId, step);
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2 text-xs">
        <StatusLabel status={stepDisplayStatus(step)} />
        {iteration ? <span className="text-muted-foreground">{iteration}</span> : null}
        {ms !== null ? (
          <span className="ms-auto text-muted-foreground tabular-nums">{formatDuration(ms)}</span>
        ) : null}
      </div>
      {step.error ? <CodeBlock tone="error">{step.error}</CodeBlock> : null}
      {step.error ? <ErrorHelp detail={step.errorDetail} /> : null}
      {question ? (
        <AskAnswer environmentId={props.environmentId} question={question} showTitle={false} />
      ) : step.result !== null && step.result !== undefined ? (
        <CodeBlock>{compactJson(step.result)}</CodeBlock>
      ) : null}
      <AgentThreadButton environmentId={props.environmentId} step={step} />
    </li>
  );
}

/** A node's steps, newest first. */
export function StepRunList(props: {
  environmentId: EnvironmentId;
  runId: string;
  steps: ReadonlyArray<AutomationStep>;
}) {
  const recent = props.steps.slice(0, MAX_STEPS);
  const hidden = props.steps.length - recent.length;
  return (
    <>
      <ul className="flex flex-col divide-y">
        {recent.map((step) => (
          <StepRun
            key={step.key}
            environmentId={props.environmentId}
            runId={props.runId}
            step={step}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="pt-2 text-xs text-muted-foreground">{hiddenPassesLabel(hidden)}</p>
      ) : null}
    </>
  );
}
