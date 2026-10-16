import {
  isExternalRunFinished,
  type ExternalRun,
  type ExternalRunJob,
  type ExternalRunStatus,
} from "@t3tools/contracts";
import {
  GITHUB_ACTIONS_RESULT_ARTIFACT,
  GITHUB_ACTIONS_WORKFLOW_FILE,
} from "@signalbox/automations/githubActionsWorkflow";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type GitHubApi, GitHubError, unreadable } from "./GitHubApi.ts";
import { zipEntry } from "./zipEntry.ts";

/**
 * GitHub Actions for automation steps that run there (`w.run(…, { on:
 * "github-actions" })`): dispatching Signalbox's step workflow, reading a run
 * as an `ExternalRun` (its jobs and steps), its result artifact, and stopping
 * it. Every call takes the token it acts with.
 */

const RunBody = Schema.Struct({
  id: Schema.Number,
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  display_title: Schema.optional(Schema.String),
});
const RunsBody = Schema.Struct({ workflow_runs: Schema.Array(RunBody) });
const JobsBody = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      started_at: Schema.NullOr(Schema.String),
      completed_at: Schema.NullOr(Schema.String),
      html_url: Schema.NullOr(Schema.String),
      steps: Schema.optional(
        Schema.Array(
          Schema.Struct({
            number: Schema.Number,
            name: Schema.String,
            status: Schema.String,
            conclusion: Schema.NullOr(Schema.String),
            started_at: Schema.optional(Schema.NullOr(Schema.String)),
            completed_at: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});
const ArtifactsBody = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({ id: Schema.Number, name: Schema.String, expired: Schema.Boolean }),
  ),
});
const DispatchBody = Schema.Struct({ workflow_run_id: Schema.Number, html_url: Schema.String });
const StepResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

const decodeJson = <A>(schema: Schema.Codec<A, unknown>) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema));

/** Decodes a REST answer's JSON text; null stays null (404). */
const decoded =
  <A>(operation: string, schema: Schema.Codec<A, unknown>) =>
  (text: string | null) =>
    text === null
      ? Effect.succeed(null)
      : Option.match(decodeJson(schema)(text), {
          onNone: () => Effect.fail(unreadable(operation)),
          onSome: Effect.succeed,
        });

/** A run's, job's or step's state as one status: GitHub splits it into `status` and `conclusion`. */
export const actionsStatus = (
  status: string | null,
  conclusion: string | null,
): ExternalRunStatus => {
  if (status !== "completed") return status === "in_progress" ? "running" : "queued";
  switch (conclusion) {
    case "success":
    case "neutral":
      return "succeeded";
    case "skipped":
      return "skipped";
    case "cancelled":
    case "stale":
      return "cancelled";
    default:
      return "failed";
  }
};

/** A finished job's log keeps this much of its end: enough to see what failed. */
const LOG_TAIL_CHARS = 4_000;
/** Step outcomes go to the run's instance as an event, which Cloudflare caps at 1 MiB. */
const RESULT_LIMIT_BYTES = 900_000;

const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const COLORS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The end of what a job's steps printed: GitHub's per-line timestamps and
 * colours, its collapsed step headers (the scripts and inputs each step ran
 * with), git's `[command]` echoes and the post-job cleanup are left out.
 */
export const logTail = (text: string) => {
  const lines: Array<string> = [];
  let grouped = false;
  for (const raw of text.slice(-200_000).split("\n")) {
    const line = raw.replace(TIMESTAMP, "").replaceAll(COLORS, "").trimEnd();
    if (line.startsWith("##[group]")) grouped = true;
    else if (line.startsWith("##[endgroup]")) grouped = false;
    else if (line === "Post job cleanup.") break;
    else if (!grouped && !line.startsWith("[command]"))
      lines.push(line.replace(/^##\[(error|warning|notice)\]/, "$1: "));
  }
  return lines.join("\n").slice(-LOG_TAIL_CHARS).trim();
};

const runOf = (
  repository: string,
  body: { readonly id: number; readonly html_url: string },
  status: ExternalRunStatus,
  jobs: ReadonlyArray<ExternalRunJob>,
): ExternalRun => ({
  system: "github-actions",
  scope: repository,
  id: String(body.id),
  url: body.html_url,
  status,
  jobs,
});

export const makeGitHubActions = (api: GitHubApi) => {
  const workflowPath = (repository: string) =>
    `/repos/${repository}/actions/workflows/${GITHUB_ACTIONS_WORKFLOW_FILE}`;

  /**
   * The run already dispatched for `step`, if any: a dispatch repeated after a
   * crash finds it by the step id its title ends with, instead of running twice.
   */
  const findDispatched = (token: string, repository: string, step: string) =>
    api
      .rest("actions.listWorkflowRuns", token, `${workflowPath(repository)}/runs`, {
        event: "workflow_dispatch",
        per_page: "30",
      })
      .pipe(
        Effect.flatMap(decoded("actions.listWorkflowRuns", RunsBody)),
        Effect.map(
          (body) =>
            body?.workflow_runs.find((run) => run.display_title?.endsWith(`[${step}]`)) ?? null,
        ),
      );

  /**
   * Starts Signalbox's step workflow on `ref`. Null when the repository has no
   * such workflow on its default branch (or the ref doesn't exist).
   */
  const dispatch = (
    token: string,
    repository: string,
    input: { readonly ref: string; readonly inputs: Readonly<Record<string, string>> },
  ) =>
    Effect.gen(function* () {
      const step = input.inputs.step ?? "";
      const existing = yield* findDispatched(token, repository, step);
      if (existing)
        return runOf(repository, existing, actionsStatus(existing.status, existing.conclusion), []);
      const answer = yield* api
        .post("actions.createWorkflowDispatch", token, `${workflowPath(repository)}/dispatches`, {
          ref: input.ref,
          inputs: input.inputs,
          return_run_details: true,
        })
        .pipe(Effect.flatMap(decoded("actions.createWorkflowDispatch", DispatchBody)));
      if (answer === null) return null;
      return runOf(
        repository,
        { id: answer.workflow_run_id, html_url: answer.html_url },
        "queued",
        [],
      );
    });

  /** A finished job's log tail, null when GitHub doesn't serve it (yet). */
  const jobLog = (token: string, repository: string, jobId: string) =>
    api
      .download(
        "actions.downloadJobLogsForWorkflowRun",
        token,
        `/repos/${repository}/actions/jobs/${jobId}/logs`,
      )
      .pipe(
        // "": tried, so a log GitHub doesn't serve isn't fetched on every read.
        Effect.map((bytes) => (bytes === null ? "" : logTail(new TextDecoder().decode(bytes)))),
        Effect.catch(() => Effect.succeed("")),
      );

  /** The run as it is now. Finished jobs get their log tail once; `previous` keeps the ones read. */
  const read = (token: string, previous: ExternalRun) =>
    Effect.gen(function* () {
      const repository = previous.scope;
      const base = `/repos/${repository}/actions/runs/${previous.id}`;
      const [run, jobs] = yield* Effect.all(
        [
          api
            .rest("actions.getWorkflowRun", token, base)
            .pipe(Effect.flatMap(decoded("actions.getWorkflowRun", RunBody))),
          api
            .rest("actions.listJobsForWorkflowRun", token, `${base}/jobs`, { per_page: "100" })
            .pipe(Effect.flatMap(decoded("actions.listJobsForWorkflowRun", JobsBody))),
        ],
        { concurrency: 2 },
      );
      if (run === null)
        return yield* new GitHubError({
          operation: "actions.getWorkflowRun",
          status: 404,
          message: `Run ${previous.id} is gone from ${repository}.`,
        });
      const known = new Map(previous.jobs.map((job) => [job.id, job]));
      const normalized = yield* Effect.forEach(
        jobs?.jobs ?? [],
        (job) =>
          Effect.gen(function* () {
            const id = String(job.id);
            const status = actionsStatus(job.status, job.conclusion);
            const tail =
              known.get(id)?.logTail ??
              (isExternalRunFinished(status) ? yield* jobLog(token, repository, id) : null);
            return {
              id,
              name: job.name,
              status,
              startedAt: job.started_at,
              finishedAt: job.completed_at,
              url: job.html_url,
              steps: (job.steps ?? []).map((step) => ({
                id: String(step.number),
                name: step.name,
                status: actionsStatus(step.status, step.conclusion),
                startedAt: step.started_at ?? null,
                finishedAt: step.completed_at ?? null,
              })),
              logTail: tail,
            } satisfies ExternalRunJob;
          }),
        { concurrency: 4 },
      );
      return runOf(repository, run, actionsStatus(run.status, run.conclusion), normalized);
    });

  /**
   * What the function returned, from the run's result artifact: its value, its
   * error, or null when the run kept no readable result.
   */
  const result = (token: string, run: ExternalRun) =>
    Effect.gen(function* () {
      const listed = yield* api
        .rest(
          "actions.listWorkflowRunArtifacts",
          token,
          `/repos/${run.scope}/actions/runs/${run.id}/artifacts`,
        )
        .pipe(Effect.flatMap(decoded("actions.listWorkflowRunArtifacts", ArtifactsBody)));
      const artifact = listed?.artifacts.find(
        (candidate) => candidate.name === GITHUB_ACTIONS_RESULT_ARTIFACT && !candidate.expired,
      );
      if (!artifact) return null;
      const archive = yield* api.download(
        "actions.downloadArtifact",
        token,
        `/repos/${run.scope}/actions/artifacts/${artifact.id}/zip`,
      );
      if (archive === null) return null;
      const file = yield* Effect.tryPromise(() => zipEntry(archive, "result.json")).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (file === null) return null;
      if (file.byteLength > RESULT_LIMIT_BYTES)
        return {
          ok: false as const,
          error: `The function's result is over ${RESULT_LIMIT_BYTES / 1_000} KB; return less, e.g. a summary.`,
        };
      return Option.getOrNull(decodeJson(StepResult)(new TextDecoder().decode(file)));
    });

  /** Stops a run; one that already finished is fine. */
  const cancel = (token: string, run: ExternalRun) =>
    api
      .post(
        "actions.cancelWorkflowRun",
        token,
        `/repos/${run.scope}/actions/runs/${run.id}/cancel`,
        {},
      )
      .pipe(
        Effect.asVoid,
        // 409: it already finished.
        Effect.catchIf(
          (error) => error.status === 409,
          () => Effect.void,
        ),
      );

  return { dispatch, read, result, cancel };
};

export type GitHubActions = ReturnType<typeof makeGitHubActions>;
