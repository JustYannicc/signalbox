/**
 * Picks which run the diagram shows. The latest run is the default; picking an
 * older one puts it in the URL (`?run=`) so it can be shared and survives a
 * reload. A running run can be cancelled from here.
 */
import type { AutomationRunSummary, EnvironmentId } from "@t3tools/contracts";
import { canRetryRun } from "@t3tools/client-runtime/automations/list";
import { runTitle } from "@t3tools/client-runtime/automations/runs";
import { runDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { MessageSquareTextIcon } from "lucide-react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CancelRunButton, RetryRunButton } from "./RunControls";
import { StatusIcon } from "./RunStatus";

function RunLine(props: { run: AutomationRunSummary }) {
  const status = runDisplayStatus(props.run);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusIcon status={status} className="size-3.5" />
      <span className="truncate">{runTitle(props.run)}</span>
      <span className="shrink-0 text-muted-foreground">
        {formatRelativeTimeLabel(props.run.startedAt)}
      </span>
    </span>
  );
}

export function RunPicker(props: {
  environmentId: EnvironmentId;
  runs: ReadonlyArray<AutomationRunSummary>;
  /** The automation's live version, for retrying an older run on it. */
  latestVersion: number;
  selected: AutomationRunSummary | null;
  onSelect: (runId: string) => void;
  onOpenChat: (runId: string) => void;
}) {
  useRelativeTimeTick(60_000);
  const { selected } = props;

  if (!selected) {
    return (
      <p className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm/5">
        No runs yet. Run it now to see each step light up.
      </p>
    );
  }

  return (
    <div className="flex max-w-[min(32rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-lg border bg-card p-1 shadow-sm/5">
      <div className="flex items-center gap-1">
        <Select value={selected.id} onValueChange={(id) => id && props.onSelect(id)}>
          <SelectTrigger size="xs" variant="ghost" aria-label="Run shown on the diagram">
            <SelectValue>
              <RunLine run={selected} />
            </SelectValue>
          </SelectTrigger>
          <SelectPopup matchTriggerWidth={false} alignItemWithTrigger={false}>
            {props.runs.map((run) => (
              <SelectItem key={run.id} value={run.id}>
                <RunLine run={run} />
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Open this run as a chat"
                onClick={() => props.onOpenChat(selected.id)}
              />
            }
          >
            <MessageSquareTextIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open this run as a chat</TooltipPopup>
        </Tooltip>
        {selected.status === "running" ? (
          <CancelRunButton environmentId={props.environmentId} runId={selected.id} />
        ) : null}
        {canRetryRun(selected) ? (
          <RetryRunButton
            environmentId={props.environmentId}
            run={selected}
            latestVersion={props.latestVersion}
            view="diagram"
          />
        ) : null}
      </div>
      {selected.error ? (
        <p className="line-clamp-3 px-2 pb-1 text-xs break-words text-destructive-foreground">
          {selected.error}
        </p>
      ) : null}
    </div>
  );
}
