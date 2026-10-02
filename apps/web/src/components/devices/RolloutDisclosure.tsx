import { ArrowRightIcon, CheckIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PHASE_LABEL, PHASES, type ExecutionServer, type RolloutStep } from "./devicesModel";

/**
 * One summary line for the rolling update, with the per-server steps behind a
 * disclosure. One server at a time: drain its chats onto a peer, update it,
 * move them back, then start the next. Chats keep running throughout.
 */
export function RolloutDisclosure({
  version,
  steps,
  servers,
}: {
  readonly version: string;
  readonly steps: readonly RolloutStep[];
  readonly servers: readonly ExecutionServer[];
}) {
  const names = new Map(servers.map((server) => [server.id, server.name]));
  const done = steps.filter((step) => step.status === "done").length;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
        />
        <span className="tabular-nums">
          Rolling update to v{version} · {done} of {steps.length} servers done · no chat interrupted
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ol className="mt-2 flex flex-col rounded-lg border border-border px-3 py-1">
          {steps.map((step, index) => (
            <li key={step.serverId} className="relative flex gap-3 py-2.5">
              {index < steps.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute top-8 bottom-0 left-2.5 w-px -translate-x-1/2 bg-border"
                />
              ) : null}
              <StepMarker status={step.status} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      step.status === "next" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {names.get(step.serverId) ?? step.serverId}
                  </span>
                  <span className="text-xs text-muted-foreground">{step.note}</span>
                </div>
                {step.status === "current" && step.phase ? (
                  <PhaseTrack current={step.phase} />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function StepMarker({ status }: { readonly status: RolloutStep["status"] }) {
  return (
    <span
      role="img"
      aria-label={status === "done" ? "Done" : status === "current" ? "In progress" : "Next"}
      className={cn(
        "relative z-10 mt-px flex size-5 shrink-0 items-center justify-center rounded-full border",
        status === "done" && "border-success/40 bg-success/12 text-success-foreground",
        status === "current" && "border-warning/50 bg-warning/12",
        status === "next" && "border-border bg-background",
      )}
    >
      {status === "done" ? <CheckIcon className="size-3" aria-hidden /> : null}
      {status === "current" ? (
        <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      ) : null}
    </span>
  );
}

function PhaseTrack({ current }: { readonly current: (typeof PHASES)[number] }) {
  const currentIndex = PHASES.indexOf(current);
  return (
    <ol aria-label="Update phases" className="flex flex-wrap items-center gap-1.5 text-xs">
      {PHASES.map((phase, index) => (
        <li key={phase} className="flex items-center gap-1.5">
          <span
            aria-current={index === currentIndex ? "step" : undefined}
            className={cn(
              "rounded-md border px-2 py-0.5",
              index < currentIndex && "border-border text-muted-foreground line-through",
              index === currentIndex &&
                "border-warning/40 bg-warning/8 font-medium text-warning-foreground dark:bg-warning/16",
              index > currentIndex && "border-dashed border-border text-muted-foreground",
            )}
          >
            {PHASE_LABEL[phase]}
          </span>
          {index < PHASES.length - 1 ? (
            <ArrowRightIcon className="size-3 text-muted-foreground" aria-hidden />
          ) : null}
        </li>
      ))}
      <li className="flex items-center gap-1.5 text-muted-foreground">
        <ArrowRightIcon className="size-3" aria-hidden />
        Next server
      </li>
    </ol>
  );
}
