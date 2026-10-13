/** What a node is configured to do, per node kind, for the details panel. */
import { Link } from "@tanstack/react-router";

import { Badge } from "../ui/badge";
import type { WorkflowNodeConfig } from "./automationModel";
import { useAssistantName } from "./useAssistantName";
import { CodeBlock, Field, Mono, Note, Prose } from "./nodeDetailsParts";
import { NodeIcon, VERDICT_LABEL, clientSignalLabel } from "./workflowNodeVisuals";

const IMPORTANCE_LABEL = {
  low: "Low: quiet badge only",
  normal: "Normal: badge where you are",
  urgent: "Urgent: phone push",
} as const;

function TriggerFields({ config }: { config: Extract<WorkflowNodeConfig, { kind: "trigger" }> }) {
  switch (config.source) {
    case "schedule":
      return (
        <>
          <Field label="Schedule">{config.summary}</Field>
          <Field label="Cron expression">
            <Mono>{config.cron}</Mono>
          </Field>
          <Field label="Timezone">{config.timezone}</Field>
        </>
      );
    case "webhook":
      return (
        <>
          <Field label="Event">
            <Mono>{config.event}</Mono>
          </Field>
          <Field label="Endpoint">
            <Mono>
              {config.method} {config.path}
            </Mono>
          </Field>
        </>
      );
    case "event":
      return (
        <>
          <Field label="Source">{config.integration}</Field>
          <Field label="Event">
            <Mono>{config.event}</Mono>
          </Field>
          {config.filter ? (
            <Field label="Only when">
              <CodeBlock>{JSON.stringify(config.filter, null, 2)}</CodeBlock>
            </Field>
          ) : null}
        </>
      );
    case "hook":
      return (
        <>
          <Field label="Hook">
            <Mono>{config.hook}</Mono>
          </Field>
          <Field label="Runs">
            {config.mode === "inline"
              ? "Inline, before it happens. Can allow, modify, hold, or block."
              : "Async, after it happens. Can't change it."}
          </Field>
          <Field label="Scope">{config.scope}</Field>
          {config.budget ? <Field label="Latency budget">{config.budget}</Field> : null}
        </>
      );
  }
}

function Labels(props: { labels: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {props.labels.map((label) => (
        <Badge key={label} variant="outline">
          {label}
        </Badge>
      ))}
    </span>
  );
}

export function ConfigFields({ config }: { config: WorkflowNodeConfig }) {
  const nameText = useAssistantName();
  switch (config.kind) {
    case "trigger":
      return <TriggerFields config={config} />;
    case "clientSignal":
      return (
        <>
          <Field label="Device">
            <span className="flex items-center gap-1.5">
              <NodeIcon config={config} className="size-3.5" />
              {config.device}
            </span>
          </Field>
          <Field label="Signal">{clientSignalLabel(config)}</Field>
          <Field label="Fires when">{config.condition}</Field>
        </>
      );
    case "agent":
      return (
        <>
          <Field label={config.provider === "assistant" ? "Assistant" : "Harness"}>
            <span className="flex items-center gap-1.5">
              <NodeIcon config={config} className="size-3.5" />
              {nameText(config.providerLabel)}
            </span>
          </Field>
          <Field label="Model">{config.model}</Field>
          <Field label="Project">{config.project}</Field>
          {config.opens ? <Field label="Opens">{nameText(config.opens)}</Field> : null}
          <Field label={config.unawareOfWorkflow ? "Message it receives" : "Prompt"}>
            <Prose>{nameText(config.prompt)}</Prose>
          </Field>
          {config.unawareOfWorkflow ? (
            <Note>
              The implementing agent never sees this workflow; it only receives review findings as
              new messages.
            </Note>
          ) : null}
        </>
      );
    case "gate":
      return (
        <>
          <Field label="Max iterations">{config.maxIterations}</Field>
          <Field label="Under the limit">{config.retryLabel}, looping back</Field>
          <Field label="At the limit">{config.exitLabel}</Field>
        </>
      );
    case "judge":
      return (
        <>
          <Field label="Model">{config.model}</Field>
          <Field label="Question">{config.question}</Field>
          <Field label="Outcomes">
            <Labels labels={config.outcomes.map((outcome) => outcome.label)} />
          </Field>
          {config.latency ? <Field label="Typical latency">{config.latency}</Field> : null}
        </>
      );
    case "verdict":
      return (
        <>
          <Field label="Does">{VERDICT_LABEL[config.action]}</Field>
          <Field label="What you see">{config.effect}</Field>
        </>
      );
    case "computer":
      return (
        <>
          <Field label="Image">{config.image}</Field>
          <Field label="Task">{config.task}</Field>
          <Field label="Lifetime">{config.lifetime}</Field>
          <Field label="Live view">
            <Link to="/computers" className="underline underline-offset-2">
              Computers
            </Link>
          </Field>
        </>
      );
    case "tool":
      return (
        <>
          <Field label="Integration">{config.integration}</Field>
          <Field label="Action">{config.action}</Field>
          <Field label="Routed through">{config.via ?? "Executor"}</Field>
          <Field label="Parameters">
            <CodeBlock>{JSON.stringify(config.params, null, 2)}</CodeBlock>
          </Field>
        </>
      );
    case "step":
      return (
        <>
          <Field label="Function">
            <Mono>{config.fn}()</Mono>
          </Field>
          <Field label="What it does">{config.summary}</Field>
          {config.params ? (
            <Field label="Parameters">
              <CodeBlock>{JSON.stringify(config.params, null, 2)}</CodeBlock>
            </Field>
          ) : null}
        </>
      );
    case "condition":
      return (
        <>
          <Field label="Expression">
            <Mono>{config.expression}</Mono>
          </Field>
          <Field label="When true">{config.trueLabel}</Field>
          <Field label="When false">{config.falseLabel}</Field>
        </>
      );
    case "handoff":
      return (
        <>
          <Field label="From">{nameText(config.from)}</Field>
          <Field label="To">{nameText(config.to)}</Field>
          <Field label="Request">{config.request}</Field>
        </>
      );
    case "approval":
      return (
        <>
          <Field label="Approver">{config.approver}</Field>
          <Field label="Asks in">{config.where}</Field>
          <Field label="Prepares">{config.prepares}</Field>
        </>
      );
    case "notify":
      return (
        <>
          <Field label="Tell you">{config.message}</Field>
          <Field label="Importance">{IMPORTANCE_LABEL[config.importance]}</Field>
          <Field label="Delivered by">
            Notification router, based on your devices and presence
          </Field>
        </>
      );
  }
}
