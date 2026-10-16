import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * A run in another system that an automation step started or watches, e.g. a
 * GitHub Actions workflow run, as clients show it inside the step: its jobs
 * and their steps, with live status and links to the run in its own tool.
 * One shape for every system (#370); GitHub Actions is the first.
 */

export const ExternalRunSystem = Schema.Literals(["github-actions"]);
export type ExternalRunSystem = typeof ExternalRunSystem.Type;

export const EXTERNAL_RUN_SYSTEM_NAMES: Record<ExternalRunSystem, string> = {
  "github-actions": "GitHub Actions",
};

/** `skipped` steps didn't run because of a condition; `cancelled` ones were stopped. */
export const ExternalRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type ExternalRunStatus = typeof ExternalRunStatus.Type;

/** Whether a run, job or step is done one way or another. */
export const isExternalRunFinished = (status: ExternalRunStatus) =>
  status !== "queued" && status !== "running";

export const ExternalRunStep = Schema.Struct({
  /** Unique within its job; GitHub numbers steps from 1. */
  id: Schema.String,
  name: Schema.String,
  status: ExternalRunStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type ExternalRunStep = typeof ExternalRunStep.Type;

export const ExternalRunJob = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: ExternalRunStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
  steps: Schema.Array(ExternalRunStep),
  /** The end of the job's log once it finished, when the system serves logs. */
  logTail: Schema.NullOr(Schema.String),
});
export type ExternalRunJob = typeof ExternalRunJob.Type;

export const ExternalRun = Schema.Struct({
  system: ExternalRunSystem,
  /** Where it runs, e.g. `owner/repo` for GitHub. */
  scope: Schema.String,
  /** The system's id for the run. */
  id: Schema.String,
  url: Schema.NullOr(Schema.String),
  status: ExternalRunStatus,
  jobs: Schema.Array(ExternalRunJob),
});
export type ExternalRun = typeof ExternalRun.Type;
