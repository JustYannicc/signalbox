import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type GitHubApi, GitHubError, unreadable } from "./GitHubApi.ts";

const PullRequest = Schema.Struct({
  merged_at: Schema.NullOr(Schema.String),
  merge_commit_sha: Schema.NullOr(Schema.String),
  base: Schema.Struct({ ref: Schema.String }),
});

const WorkflowRun = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  head_sha: Schema.String,
  head_branch: Schema.String,
  event: Schema.String,
  status: Schema.Literals([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: Schema.NullOr(Schema.String),
});

export interface DeploymentRunRead {
  readonly id: string;
  readonly url: string;
  readonly status: "pending" | "failed" | "succeeded";
  readonly commit: string;
}

export interface DeploymentRead {
  readonly commit: string;
  readonly baseBranch: string;
  readonly run: DeploymentRunRead | null;
}

const decode = <A>(operation: string, schema: Schema.Codec<A, unknown>, text: string | null) => {
  if (text === null) {
    return Effect.fail(
      new GitHubError({
        operation,
        status: 404,
        message: "GitHub could not find the pull request or workflow run.",
      }),
    );
  }

  return Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text), {
    onNone: () => Effect.fail(unreadable(operation)),
    onSome: Effect.succeed,
  });
};

const readError = (operation: string, message: string) =>
  new GitHubError({ operation, status: 409, message });

const isCommitSha = (value: string) => /^[a-f0-9]{40}$/i.test(value);

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const runStatus = (run: typeof WorkflowRun.Type): DeploymentRunRead["status"] => {
  if (run.status !== "completed" || run.conclusion === "action_required") return "pending";
  return run.conclusion === "success" ? "succeeded" : "failed";
};

/** Reads GitHub's merged commit and optional workflow-run evidence for deployment checks. */
export const makeDeploymentReads = (api: GitHubApi) => ({
  read: (
    token: string,
    repository: string,
    prNumber: number,
    runId?: string,
  ): Effect.Effect<DeploymentRead, GitHubError> =>
    Effect.gen(function* () {
      const pullOperation = "deploymentReads.pullRequest";
      const pullText = yield* api.rest(
        pullOperation,
        token,
        `/repos/${repository}/pulls/${prNumber}`,
      );
      const pull = yield* decode(pullOperation, PullRequest, pullText);

      if (
        pull.merged_at === null ||
        pull.merged_at.length === 0 ||
        pull.merge_commit_sha === null ||
        !isCommitSha(pull.merge_commit_sha) ||
        pull.base.ref.length === 0
      ) {
        return yield* readError(
          pullOperation,
          "GitHub has not recorded this pull request as merged with a valid commit.",
        );
      }

      const commit = pull.merge_commit_sha.toLowerCase();
      if (runId === undefined) return { commit, baseBranch: pull.base.ref, run: null };

      if (!/^\d+$/.test(runId)) {
        return yield* new GitHubError({
          operation: "deploymentReads.workflowRun",
          status: 400,
          message: "The workflow run id is invalid.",
        });
      }

      const runOperation = "deploymentReads.workflowRun";
      const runText = yield* api.rest(
        runOperation,
        token,
        `/repos/${repository}/actions/runs/${runId}`,
      );
      const run = yield* decode(runOperation, WorkflowRun, runText);

      if (
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        String(run.id) !== runId ||
        !isCommitSha(run.head_sha) ||
        run.head_sha.toLowerCase() !== commit ||
        run.head_branch !== pull.base.ref ||
        run.event === "pull_request" ||
        run.event === "pull_request_target" ||
        !isHttpsUrl(run.html_url) ||
        (run.status === "completed" && run.conclusion === null)
      ) {
        return yield* readError(
          runOperation,
          "The workflow run does not provide deployment evidence for this merged pull request.",
        );
      }

      return {
        commit,
        baseBranch: pull.base.ref,
        run: {
          id: String(run.id),
          url: run.html_url,
          status: runStatus(run),
          commit: run.head_sha.toLowerCase(),
        },
      };
    }),
});
