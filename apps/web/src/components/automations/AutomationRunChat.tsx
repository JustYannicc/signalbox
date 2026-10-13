/**
 * A run as a chat: how it started, one message per step in the order they
 * ran (a loop's passes gathered where the loop ran), and how it ended. A
 * question waiting on you is answered right in its message. "Show on diagram"
 * opens the same run drawn over the diagram.
 */
import type { AutomationRunDetail, EnvironmentId } from "@t3tools/contracts";
import { durationMs, RUN_TRIGGER_LABEL } from "@t3tools/client-runtime/automations/labels";
import { canRetryRun } from "@t3tools/client-runtime/automations/list";
import { resultLine, runChatItems, runTitle } from "@t3tools/client-runtime/automations/runs";
import { runDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement, useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { LoopMessage, StepMessage } from "./RunChatMessages";
import { CancelRunButton, RetryRunButton } from "./RunControls";
import { ErrorHelp, RunLogs } from "./RunDiagnostics";
import { RunStatusMarker } from "./RunStatus";

/** The first and last messages: how the run started and how it ended. */
function EdgeMessage(props: {
  icon: LucideIcon;
  tone?: "error" | "success";
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          props.tone === "error"
            ? "bg-destructive/10 text-destructive-foreground"
            : props.tone === "success"
              ? "bg-success/10 text-success-foreground"
              : "bg-info/12 text-info-foreground",
        )}
      >
        {createElement(props.icon, { "aria-hidden": true, className: "size-4.5" })}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1.5">
        <span className="text-sm font-medium text-foreground">{props.title}</span>
        {props.children}
      </div>
    </li>
  );
}

function EndMessage(props: { run: AutomationRunDetail }) {
  const { run } = props;
  switch (run.run.status) {
    case "running":
      return run.run.waitingOnYou ? null : (
        <EdgeMessage icon={CircleDashedIcon} title="Still running" />
      );
    case "succeeded": {
      const output = resultLine(run.output);
      return (
        <EdgeMessage icon={CircleCheckIcon} tone="success" title="Finished">
          {output ? <p className="text-sm break-words text-muted-foreground">{output}</p> : null}
        </EdgeMessage>
      );
    }
    case "failed":
      return (
        <EdgeMessage icon={CircleAlertIcon} tone="error" title="Failed">
          {run.run.error ? (
            <p className="line-clamp-6 text-sm whitespace-pre-wrap break-words text-destructive-foreground">
              {run.run.error}
            </p>
          ) : null}
          {/* A failed step already explains the same error above. */}
          {run.steps.some(
            (step) => step.status === "failed" && step.error === run.run.error,
          ) ? null : (
            <ErrorHelp detail={run.run.errorDetail} />
          )}
        </EdgeMessage>
      );
    case "cancelled":
      return <EdgeMessage icon={CircleSlashIcon} title="Cancelled" />;
  }
}

export function AutomationRunChat(props: {
  environmentId: EnvironmentId;
  run: AutomationRunDetail;
  /** The automation's current version, to flag a run of an earlier one. */
  version: number;
  triggerIcon: LucideIcon;
  onShowOnDiagram: () => void;
}) {
  useRelativeTimeTick(60_000);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { run, environmentId } = props;
  const summary = run.run;
  const items = useMemo(() => runChatItems(run.steps), [run.steps]);
  const ms = durationMs(summary);
  const input = resultLine(run.input);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium text-foreground">{runTitle(summary)}</h2>
            <RunStatusMarker status={runDisplayStatus(summary)} />
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {RUN_TRIGGER_LABEL[summary.trigger]} ·{" "}
            {formatDayAwareTimestamp(summary.startedAt, timestampFormat)}
            {ms !== null ? ` · ${formatDuration(ms)}` : ""}
            {summary.version !== props.version ? " · earlier version" : ""}
            {summary.retryOf ? " · retry" : ""}
          </span>
        </div>
        {summary.status === "running" ? (
          <CancelRunButton environmentId={environmentId} runId={summary.id} />
        ) : null}
        {canRetryRun(summary) ? (
          <RetryRunButton
            environmentId={environmentId}
            run={summary}
            latestVersion={props.version}
          />
        ) : null}
        <Button size="xs" variant="ghost" onClick={props.onShowOnDiagram}>
          <WorkflowIcon />
          Show on diagram
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
          <EdgeMessage icon={props.triggerIcon} title={RUN_TRIGGER_LABEL[summary.trigger]}>
            {input ? (
              <p className="text-sm break-words text-muted-foreground">With {input}</p>
            ) : null}
          </EdgeMessage>
          {items.map((item) =>
            item.kind === "step" ? (
              <StepMessage
                key={item.step.key}
                environmentId={environmentId}
                runId={summary.id}
                graph={run.graph}
                step={item.step}
              />
            ) : (
              <LoopMessage
                key={item.key}
                environmentId={environmentId}
                runId={summary.id}
                graph={run.graph}
                nodeId={item.nodeId}
                passes={item.passes}
              />
            ),
          )}
          <EndMessage run={run} />
        </ol>
        <div className="mx-auto w-full max-w-3xl px-6 pb-6 empty:hidden">
          <RunLogs logs={run.logs} />
        </div>
      </ScrollArea>
    </div>
  );
}
