import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type GitHubApi, GitHubError, unreadable } from "../GitHubApi.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
const MAX_WORKFLOW_RUN_RESULTS = 1_000;

export const WorkflowRunBody = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  path: Schema.String,
  head_sha: Schema.String,
  display_title: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.String,
});
export type WorkflowRunBody = typeof WorkflowRunBody.Type;

const WorkflowRunsBody = Schema.Struct({
  total_count: Schema.optional(Schema.Number),
  workflow_runs: Schema.Array(WorkflowRunBody),
});

export const DispatchBody = Schema.Struct({
  workflow_run_id: Schema.Number,
  html_url: Schema.String,
});
export type DispatchBody = typeof DispatchBody.Type;

const ArtifactBody = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  expired: Schema.Boolean,
  size_in_bytes: Schema.Number,
  digest: Schema.String,
});
export type ArtifactBody = typeof ArtifactBody.Type;

const ArtifactsBody = Schema.Struct({
  artifacts: Schema.Array(ArtifactBody),
});

export const IssueBody = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
  pull_request: Schema.optional(Schema.Unknown),
});
export type IssueBody = typeof IssueBody.Type;

const IssueListBody = Schema.Array(IssueBody);

const failed = (message: string, cause?: unknown) =>
  new AutomationError({ message, ...(cause === undefined ? {} : { cause }) });

const call = <A>(what: string, effect: Effect.Effect<A, GitHubError>) =>
  effect.pipe(Effect.mapError((cause) => failed(what + ".", cause)));

const decoded = <A>(operation: string, schema: Schema.Codec<A, unknown>, text: string | null) => {
  if (text === null)
    return Effect.fail(failed("GitHub could not find the requested workflow resource."));
  return Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), {
    onNone: () =>
      Effect.fail(
        failed(
          "GitHub returned an unreadable response for " + operation + ".",
          unreadable(operation),
        ),
      ),
    onSome: Effect.succeed,
  });
};

const repositoryPath = (repository: string) => "/repos/" + repository;

const listAll = <A>(
  operation: string,
  readPage: (page: number) => Effect.Effect<ReadonlyArray<A>, AutomationError>,
) =>
  Effect.gen(function* () {
    const values: Array<A> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = yield* readPage(page);
      values.push(...items);
      if (items.length < PAGE_SIZE) return values;
    }
    return yield* failed("GitHub returned more pages than Signalbox can read completely.");
  });

export const makeWorkflowRest = (api: GitHubApi) => {
  const workflowRuns = (token: string, repository: string, workflowName: string, headSha: string) =>
    Effect.gen(function* () {
      const values: Array<WorkflowRunBody> = [];
      let capped = false;
      const pages = MAX_WORKFLOW_RUN_RESULTS / PAGE_SIZE;
      for (let page = 1; page <= pages; page++) {
        const path =
          repositoryPath(repository) +
          "/actions/workflows/" +
          encodeURIComponent(workflowName) +
          "/runs";
        const text = yield* call(
          "Couldn't list GitHub Actions runs",
          api.rest("workflowRuns.list", token, path, {
            head_sha: headSha,
            per_page: String(PAGE_SIZE),
            page: String(page),
          }),
        );
        const body = yield* decoded("workflowRuns.list", WorkflowRunsBody, text);
        values.push(...body.workflow_runs);
        capped ||= (body.total_count ?? 0) >= MAX_WORKFLOW_RUN_RESULTS;

        if (body.workflow_runs.length < PAGE_SIZE) return { runs: values, capped };
      }
      return { runs: values, capped: true };
    });

  const readRun = (token: string, repository: string, runId: string) =>
    Effect.gen(function* () {
      const path = repositoryPath(repository) + "/actions/runs/" + runId;
      const text = yield* call(
        "Couldn't read the GitHub Actions run",
        api.rest("workflowRuns.read", token, path),
      );
      if (text === null) return null;
      return yield* decoded("workflowRuns.read", WorkflowRunBody, text);
    });

  const dispatch = (
    token: string,
    repository: string,
    workflowName: string,
    input: { readonly ref: string; readonly inputs: Readonly<Record<string, string>> },
  ) =>
    call(
      "GitHub refused the workflow dispatch",
      api.post(
        "workflowRuns.dispatch",
        token,
        repositoryPath(repository) +
          "/actions/workflows/" +
          encodeURIComponent(workflowName) +
          "/dispatches",
        { ref: input.ref, inputs: input.inputs, return_run_details: true },
      ),
    );

  const artifacts = (token: string, repository: string, runId: string) =>
    listAll("workflow artifacts", (page) =>
      Effect.gen(function* () {
        const text = yield* call(
          "Couldn't list workflow artifacts",
          api.rest(
            "workflowArtifacts.list",
            token,
            repositoryPath(repository) + "/actions/runs/" + runId + "/artifacts",
            { per_page: String(PAGE_SIZE), page: String(page) },
          ),
        );
        const body = yield* decoded("workflowArtifacts.list", ArtifactsBody, text);
        return body.artifacts;
      }),
    );

  const downloadArtifact = (token: string, repository: string, artifactId: string) =>
    call(
      "Couldn't download the GitHub Actions artifact",
      api.download(
        "workflowArtifacts.download",
        token,
        repositoryPath(repository) + "/actions/artifacts/" + artifactId + "/zip",
      ),
    );

  const issues = (token: string, repository: string) =>
    listAll("repository issues", (page) =>
      Effect.gen(function* () {
        const text = yield* call(
          "Couldn't list repository issues",
          api.rest("issues.list", token, repositoryPath(repository) + "/issues", {
            state: "all",
            per_page: String(PAGE_SIZE),
            page: String(page),
          }),
        );
        const body = yield* decoded("issues.list", IssueListBody, text);
        return body;
      }),
    );

  const createIssue = (
    token: string,
    repository: string,
    input: { readonly title: string; readonly body: string },
  ) =>
    call(
      "GitHub refused to create the issue",
      api.post("issues.create", token, repositoryPath(repository) + "/issues", input),
    );

  return { workflowRuns, readRun, dispatch, artifacts, downloadArtifact, issues, createIssue };
};

export type WorkflowRest = ReturnType<typeof makeWorkflowRest>;
