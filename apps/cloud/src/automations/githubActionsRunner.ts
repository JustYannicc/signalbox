import { isExternalRunFinished, type ExternalRun } from "@t3tools/contracts";
import type { ExternalRead, ExternalRunner } from "@signalbox/automations/external";
import {
  GITHUB_ACTIONS_WORKFLOW_PATH,
  GITHUB_DISPATCH_INPUTS_LIMIT,
  type GitHubActionsPayload,
} from "@signalbox/automations/githubActionsWorkflow";
import { toJson } from "@signalbox/automations/json";
import { explained } from "@signalbox/automations/runLog";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubActions } from "../github/GitHubActions.ts";

/**
 * `w.run(…, { on: "github-actions" })` in the cloud: the step's function
 * goes to Signalbox's step workflow in the folder's repository. Where it runs
 * and as whom is `GitHubActions`'s; this only speaks the step workflow.
 */

const installFix = `Ask an agent in this folder to add ${GITHUB_ACTIONS_WORKFLOW_PATH} from the signalbox-automations skill (reference "github-actions") in a pull request, and merge it.`;

/** What a step on GitHub Actions may say besides `on` and `timeout`. */
const StepOptions = Schema.Struct({
  ref: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  secrets: Schema.optional(Schema.Array(Schema.String)),
});
const decodeOptions = Schema.decodeUnknownEffect(StepOptions, { onExcessProperty: "error" });

/** The engine's `ExternalRunner` for GitHub Actions, on the `GitHubActions` service. */
export const makeGitHubActionsRunner = Effect.gen(function* () {
  const actions = yield* GitHubActions;

  const runner: ExternalRunner = {
    dispatch: (input) =>
      Effect.gen(function* () {
        const options = yield* decodeOptions(input.options).pipe(
          Effect.mapError(() =>
            explained("These w.run options don't fit a step on GitHub Actions.", {
              fix: 'Use { on: "github-actions", ref?: "branch", environment?: "name", secrets?: ["NAME"], timeout?: { hours: 1 } }.',
            }),
          ),
        );
        const payload: GitHubActionsPayload = {
          module: input.module,
          name: input.name,
          args: input.args,
          secrets: options.secrets ?? [],
        };
        const inputs = {
          step: input.stepId,
          label: input.label,
          payload: toJson(payload),
          environment: options.environment ?? "",
        };
        if (
          Object.values(inputs).reduce((total, value) => total + value.length, 0) >
          GITHUB_DISPATCH_INPUTS_LIMIT
        )
          return yield* explained(
            "The function and its arguments are too big to send to GitHub Actions.",
            {
              why: `GitHub takes at most ${GITHUB_DISPATCH_INPUTS_LIMIT} characters of inputs per dispatch.`,
              fix: "Pass less: e.g. a path or an id the function reads, instead of the data.",
            },
          );
        const started = yield* actions.dispatch(input.projectId, { ref: options.ref, inputs });
        if (started._tag === "no-workflow")
          return yield* explained(
            `${started.repository} doesn't have Signalbox's step workflow on its default branch, or has no ${started.ref}.`,
            { fix: installFix },
          );
        return started.run;
      }),
    read: (_projectId, previous) =>
      Effect.gen(function* () {
        const run = yield* actions.read(previous);
        // Deleted, or no longer visible to this account: reading again won't help.
        if (run === null)
          return {
            run: previous,
            outcome: {
              ok: false,
              error: `Run ${previous.id} is gone from ${previous.scope} on GitHub.`,
              detail: {
                why: null,
                fix: "Retry the run to start the step again.",
                link: previous.url,
              },
            },
          } satisfies ExternalRead;
        if (!isExternalRunFinished(run.status)) return { run } satisfies ExternalRead;
        return { run, outcome: outcomeOf(run, yield* actions.result(run)) } satisfies ExternalRead;
      }),
    cancel: (_projectId, run) => actions.cancel(run),
  };
  return runner;
});

/** How a finished run settles its step: the function's result, else why there is none. */
export const outcomeOf = (
  run: ExternalRun,
  result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: string }
    | null,
): NonNullable<ExternalRead["outcome"]> => {
  const link = run.url;
  if (result?.ok === true) return { ok: true, value: result.value };
  if (result?.ok === false)
    return {
      ok: false,
      error: result.error,
      detail: { why: null, fix: "Open the run on GitHub for its whole log.", link },
    };
  const failedStep = run.jobs
    .flatMap((job) => job.steps.map((step) => ({ job, step })))
    .find(({ step }) => step.status === "failed");
  const where = failedStep ? ` at "${failedStep.job.name}: ${failedStep.step.name}"` : "";
  return {
    ok: false,
    error:
      run.status === "cancelled"
        ? "The run on GitHub Actions was cancelled."
        : run.status === "succeeded"
          ? "The run on GitHub Actions finished without the function's result."
          : `The run on GitHub Actions failed${where}.`,
    detail: {
      why:
        run.status === "succeeded"
          ? `Signalbox's step workflow keeps it as an artifact; ${GITHUB_ACTIONS_WORKFLOW_PATH} may have changed.`
          : null,
      fix: "Open the run on GitHub for its log.",
      link,
    },
  };
};
