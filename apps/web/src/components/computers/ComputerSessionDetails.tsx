/** Side column of a computer session: what happened, what was kept, and sync health. */
import {
  ArrowLeftRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileTextIcon,
  ImageIcon,
  ScrollTextIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { notifyComputerPrototype } from "./computerPrimitives";
import {
  formatBytes,
  formatMinutes,
  type Computer,
  type ComputerArtifact,
  type ComputerStepStatus,
} from "./computerModel";

const STEP_ICON = {
  done: { Icon: CircleCheckIcon, tone: "text-success", label: "Done" },
  running: { Icon: CircleDotIcon, tone: "text-info", label: "Running" },
  pending: { Icon: CircleDashedIcon, tone: "text-icon-muted", label: "Waiting" },
  failed: { Icon: CircleXIcon, tone: "text-destructive", label: "Failed" },
} as const satisfies Record<ComputerStepStatus, unknown>;

const ARTIFACT_ICON = {
  screenshot: ImageIcon,
  log: ScrollTextIcon,
  report: FileTextIcon,
  archive: FileArchiveIcon,
} as const satisfies Record<ComputerArtifact["kind"], unknown>;

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="text-xs font-medium text-muted-foreground">
      {children}
    </h2>
  );
}

function StepsTimeline({ computer }: { computer: Computer }) {
  return (
    <section aria-labelledby="computer-steps" className="flex flex-col gap-2">
      <SectionHeading id="computer-steps">Steps</SectionHeading>
      <ol className="flex flex-col">
        {computer.steps.map((step, index) => {
          const { Icon, tone, label } = STEP_ICON[step.status];
          const isLast = index === computer.steps.length - 1;
          return (
            <li key={step.id} className="relative flex gap-3 pb-4 last:pb-0">
              {isLast ? null : (
                <span aria-hidden className="absolute top-5 bottom-0 left-2 w-px bg-border" />
              )}
              <Icon aria-label={label} className={cn("mt-0.5 size-4 shrink-0", tone)} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2 text-sm text-foreground">
                  <span className="min-w-0 flex-1 truncate font-medium">{step.label}</span>
                  {step.atMinute === null ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      +{step.atMinute}m
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ArtifactsList({ computer }: { computer: Computer }) {
  const total = computer.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  return (
    <section aria-labelledby="computer-artifacts" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionHeading id="computer-artifacts">Retained artifacts</SectionHeading>
        <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(total)}</span>
      </div>
      <ul className="flex flex-col">
        {computer.artifacts.map((artifact) => {
          const Icon = ARTIFACT_ICON[artifact.kind];
          return (
            <li key={artifact.name} className="flex items-center gap-2 py-1">
              <Icon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {artifact.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatBytes(artifact.bytes)}
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Download ${artifact.name}`}
                onClick={() =>
                  notifyComputerPrototype(
                    `Download ${artifact.name}`,
                    "Artifacts live in the durable workspace.",
                  )
                }
              >
                <DownloadIcon />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SyncStatus({ computer }: { computer: Computer }) {
  const released = computer.state === "released";
  const when =
    computer.lastSyncMinutesAgo === 0
      ? "just now"
      : `${formatMinutes(computer.lastSyncMinutesAgo)} ago`;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <ArrowLeftRightIcon
        aria-hidden
        className={cn("size-3.5 shrink-0", released ? "text-icon-muted" : "text-success")}
      />
      <span>
        {released ? "Final sync to durable workspace" : "Files synced ↔ durable workspace"}
        <span className="text-icon-muted"> · </span>
        {when}
      </span>
    </p>
  );
}

export function ComputerSessionDetails({ computer }: { computer: Computer }) {
  return (
    <div className="flex flex-col gap-6">
      <SyncStatus computer={computer} />
      <StepsTimeline computer={computer} />
      <ArtifactsList computer={computer} />
    </div>
  );
}
