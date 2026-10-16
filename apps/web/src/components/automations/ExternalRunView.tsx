/**
 * The run in another system a step started, e.g. on GitHub Actions: its jobs
 * and their steps with live status and timing, each finished job's log tail,
 * and a link to the run where it lives. Read-only; the system owns the run.
 */
import {
  EXTERNAL_RUN_SYSTEM_NAMES,
  type ExternalRun,
  type ExternalRunJob,
} from "@t3tools/contracts";
import { durationMs } from "@t3tools/client-runtime/automations/labels";
import { externalDisplayStatus } from "@t3tools/client-runtime/automations/status";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { ExternalLinkIcon } from "lucide-react";

import { GitHubIcon } from "../Icons";
import { StatusIcon } from "./RunStatus";
import { CodeBlock } from "./CodeBlock";

function Timing(props: { entry: { startedAt: string | null; finishedAt: string | null } }) {
  const ms = durationMs(props.entry);
  return ms === null ? null : (
    <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">
      {formatDuration(ms)}
    </span>
  );
}

function Job(props: { job: ExternalRunJob }) {
  const { job } = props;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
        <StatusIcon status={externalDisplayStatus(job.status)} className="size-3.5" />
        {job.url ? (
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="truncate underline-offset-2 hover:underline"
          >
            {job.name}
          </a>
        ) : (
          <span className="truncate">{job.name}</span>
        )}
        <Timing entry={job} />
      </div>
      {job.steps.length > 0 ? (
        <ol className="ms-[7px] flex flex-col gap-0.5 border-s ps-3">
          {job.steps.map((step) => (
            <li
              key={step.id}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            >
              <StatusIcon status={externalDisplayStatus(step.status)} className="size-3" />
              <span className="truncate">{step.name}</span>
              <Timing entry={step} />
            </li>
          ))}
        </ol>
      ) : null}
      {job.logTail ? (
        <details className="ms-[7px] ps-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none">Log</summary>
          <div className="pt-1">
            <CodeBlock {...(job.status === "failed" ? { tone: "error" as const } : {})}>
              {job.logTail}
            </CodeBlock>
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function ExternalRunView(props: { run: ExternalRun }) {
  const { run } = props;
  return (
    <section
      aria-label={`${EXTERNAL_RUN_SYSTEM_NAMES[run.system]} run`}
      className="flex flex-col gap-2 rounded-md border px-2.5 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <GitHubIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">{EXTERNAL_RUN_SYSTEM_NAMES[run.system]}</span>
        <span className="truncate text-muted-foreground">
          {run.scope}
          {run.actingAs ? ` · as @${run.actingAs}` : ""}
        </span>
        {run.url ? (
          <a
            href={run.url}
            target="_blank"
            rel="noreferrer"
            className="ms-auto inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            Open run
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        ) : null}
      </div>
      {run.jobs.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {run.jobs.map((job) => (
            <Job key={job.id} job={job} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {run.status === "queued" ? "Waiting for a runner…" : "No jobs yet."}
        </p>
      )}
    </section>
  );
}
