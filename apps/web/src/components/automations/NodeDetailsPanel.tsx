/**
 * The side panel for whatever is selected on the diagram: what the step is,
 * what it did in the selected run, and the code that wrote it. Details live
 * here so the diagram itself stays about the shape of the automation.
 */
import type {
  AutomationRunDetail,
  EnvironmentId,
  WorkflowGraph,
  WorkflowNode,
  WorkflowTrigger,
} from "@t3tools/contracts";
import type { DiagramRun } from "@t3tools/client-runtime/automations/diagram";
import {
  CONTAINER_TYPE_LABEL,
  RUN_TRIGGER_LABEL,
  compactJson,
  stepTypeLabel,
} from "@t3tools/client-runtime/automations/labels";
import type { WorkflowLayout } from "@t3tools/client-runtime/automations/layout";
import { findWorkflowNode, stepsForNode } from "@t3tools/client-runtime/automations/runs";
import { describeTrigger } from "@t3tools/client-runtime/automations/triggers";
import { CodeIcon, SplitIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { detailText, stepArgs } from "./automationFormat";
import { LoopPassList } from "./LoopPassList";
import { StepTile } from "./nodeVisuals";
import { CodeBlock, StepRunList } from "./StepRunList";

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

const Muted = (props: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{props.children}</p>
);

export function NodeDetailsPanel(props: {
  environmentId: EnvironmentId;
  selectedId: string;
  graph: WorkflowGraph;
  layout: WorkflowLayout;
  triggers: ReadonlyArray<WorkflowTrigger>;
  run: AutomationRunDetail | null;
  diagram: DiagramRun | null;
  onShowLine: (line: number) => void;
  onClose: () => void;
}) {
  const { run, diagram, selectedId } = props;
  const node = selectedId === "trigger" ? null : findWorkflowNode(props.graph.nodes, selectedId);
  const steps = run ? stepsForNode(run.steps, selectedId) : [];
  const container = props.layout.containers.find((entry) => entry.id === selectedId);
  const takenOption = props.layout.edges.find(
    (edge) => edge.arm?.decisionId === selectedId && diagram?.edges.get(edge.id) === "taken",
  )?.label;

  const title =
    node?.type === "step" || node?.type === "branch" || node?.type === "loop"
      ? node.label.text
      : (container?.label ?? (node?.type === "end" ? "End" : "Trigger"));
  const type =
    node?.type === "step"
      ? stepTypeLabel(node)
      : node?.type === "branch"
        ? "Decision"
        : node?.type === "loop" || node?.type === "parallel" || node?.type === "try"
          ? CONTAINER_TYPE_LABEL[node.type === "loop" ? node.verb : node.type]
          : node?.type === "end"
            ? "Ends here"
            : "Starts";

  return (
    <aside
      aria-label={`${title} details`}
      className="flex w-80 shrink-0 flex-col border-l bg-card max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-10 max-md:shadow-lg"
    >
      <header className="flex items-start gap-3 border-b px-4 py-3">
        {node?.type === "step" ? (
          <StepTile node={node} size="panel" />
        ) : node?.type === "branch" ? (
          <span className="m-1 flex size-6 shrink-0 rotate-45 items-center justify-center rounded-md bg-foreground text-background">
            <SplitIcon aria-hidden className="size-3.5 -rotate-45" />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs text-muted-foreground">{type}</span>
          <h2 className="text-sm font-medium text-balance break-words text-foreground">{title}</h2>
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
        {selectedId === "trigger" ? (
          <>
            <Section title="Starts">
              <ul className="flex flex-col gap-1 text-sm text-foreground">
                {props.triggers.map((trigger) => (
                  <li key={JSON.stringify(trigger)}>{describeTrigger(trigger)}</li>
                ))}
                <li className="text-muted-foreground">Or when you choose Run now</li>
              </ul>
            </Section>
            {run ? (
              <Section title="This run">
                <Muted>{RUN_TRIGGER_LABEL[run.run.trigger]}</Muted>
                {run.input !== null && run.input !== undefined ? (
                  <CodeBlock>{compactJson(run.input)}</CodeBlock>
                ) : null}
              </Section>
            ) : null}
          </>
        ) : null}

        {run && node?.type === "step" ? (
          <Section title="This run">
            {steps.length > 0 ? (
              <StepRunList environmentId={props.environmentId} runId={run.run.id} steps={steps} />
            ) : (
              <Muted>{run.run.status === "running" ? "Not reached yet." : "Didn't run."}</Muted>
            )}
          </Section>
        ) : null}
        {run && node?.type === "branch" ? (
          <Section title="This run">
            <Muted>
              {takenOption ? (
                <>
                  Took <span className="font-medium text-foreground">{takenOption}</span>
                </>
              ) : diagram?.reached.has(selectedId) ? (
                "The option it took isn't recorded."
              ) : (
                "Didn't get here."
              )}
            </Muted>
          </Section>
        ) : null}
        {run && node?.type === "loop" && (node.verb === "each" || node.verb === "repeat") ? (
          <Section title="Passes in this run">
            <LoopPassList
              steps={run.steps}
              loopId={selectedId}
              max={node.verb === "repeat" ? node.max : undefined}
            />
          </Section>
        ) : run && container ? (
          <Section title="This run">
            <Muted>
              {diagram?.loops.get(selectedId)
                ? `${diagram.loops.get(selectedId)} passes`
                : diagram?.reached.has(selectedId)
                  ? "Ran."
                  : "Didn't get here."}
            </Muted>
          </Section>
        ) : null}

        {node?.type === "branch" ? (
          <Section title="Options">
            <ul className="flex flex-wrap gap-1.5">
              {node.arms.map((arm) => (
                <li
                  key={arm.label}
                  className="rounded-full border px-2 text-xs leading-5 text-foreground"
                >
                  {arm.label || "Otherwise"}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {node?.type === "step" ? <StepOptions node={node} run={steps[0]?.args} /> : null}
        {container?.detail ? (
          <Section title="Runs">
            <Muted>{container.detail}</Muted>
          </Section>
        ) : null}

        {node ? (
          <div className="px-4 py-3">
            <Button size="xs" variant="ghost-muted" onClick={() => props.onShowLine(node.line)}>
              <CodeIcon />
              Show in code · line {node.line}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  );
}

function StepOptions(props: { node: Extract<WorkflowNode, { type: "step" }>; run: unknown }) {
  // What it actually ran with beats what the code says it will run with.
  const text =
    props.run !== undefined ? compactJson(stepArgs(props.run)) : detailText(props.node.detail);
  if (!text) return null;
  return (
    <Section title={props.run !== undefined ? "Ran with" : "Options"}>
      <CodeBlock>{text}</CodeBlock>
    </Section>
  );
}
