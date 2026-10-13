/**
 * Every pass of a loop in one run, for the details panel: how each went, how
 * long it took and what it ended with, so a review loop shows how it got
 * there and not just its last pass.
 */
import type { AutomationStep } from "@t3tools/contracts";
import { hiddenPassesLabel } from "@t3tools/client-runtime/automations/labels";
import { loopPasses, passSummary } from "@t3tools/client-runtime/automations/runs";
import { stepDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { cn } from "~/lib/utils";
import { StatusIcon } from "./RunStatus";

/** Most recent passes listed; an `each` over hundreds of items keeps the panel cheap. */
const MAX_PASSES = 30;

export function LoopPassList(props: {
  steps: ReadonlyArray<AutomationStep>;
  loopId: string;
  max: number | undefined;
}) {
  const passes = loopPasses(props.steps, props.loopId);
  if (passes.length === 0) return <p className="text-sm text-muted-foreground">Didn't run.</p>;
  const shown = passes.slice(-MAX_PASSES);
  const hidden = passes.length - shown.length;
  return (
    <ol className="flex flex-col gap-2.5" aria-label="Passes">
      {hidden > 0 ? (
        <li className="text-xs text-muted-foreground">{hiddenPassesLabel(hidden)}</li>
      ) : null}
      {shown.map((pass) => {
        const summary = passSummary(pass);
        return (
          <li key={pass.index} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs">
              <StatusIcon status={stepDisplayStatus(summary.step)} className="size-3.5" />
              <span className="font-medium text-foreground">
                Pass {pass.index + 1}
                {props.max ? ` / ${props.max}` : ""}
              </span>
              {summary.durationMs !== null ? (
                <span className="ms-auto text-muted-foreground tabular-nums">
                  {formatDuration(summary.durationMs)}
                </span>
              ) : null}
            </span>
            {summary.line ? (
              <span
                className={cn(
                  "line-clamp-2 ps-5 text-sm text-pretty break-words",
                  summary.status === "failed"
                    ? "text-destructive-foreground"
                    : "text-muted-foreground",
                )}
              >
                {summary.line}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
