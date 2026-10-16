import {
  AutomationError,
  isExternalRunFinished,
  ProjectId,
  type ExternalRun,
} from "@t3tools/contracts";
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

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { GitHub } from "../github/GitHub.ts";
import { makeGitHubActions } from "../github/GitHubActions.ts";
import { GitHubConnection } from "../github/GitHubConnection.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";

/**
 * `w.run(…, { on: "github-actions" })` in the cloud: steps run on the folder
 * repository's Actions runners through Signalbox's step workflow, acting with
 * the automation owner's GitHub connection. Until Executor's per-folder
 * GitHub App exists (#641), that connection is the only one the cloud has;
 * this module is the one place that changes when it does.
 */

const installFix = `Ask an agent in this folder to add ${GITHUB_ACTIONS_WORKFLOW_PATH} from the signalbox-automations skill (reference "github-actions") in a pull request, and merge it.`;

const failed = (message: string, cause?: unknown) =>
  new AutomationError({ message, ...(cause === undefined ? {} : { cause }) });

/** What a step on GitHub Actions may say besides `on` and `timeout`. */
const StepOptions = Schema.Struct({
  ref: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  secrets: Schema.optional(Schema.Array(Schema.String)),
});
const decodeOptions = Schema.decodeUnknownEffect(StepOptions, { onExcessProperty: "error" });

export const makeGitHubActionsRunner = (owner: Effect.Effect<Actor, AutomationError>) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const connection = yield* GitHubConnection;
    const userDrives = yield* UserDrives.UserDrives;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    const actions = makeGitHubActions(github.api);

    const token = connection.accessToken.pipe(
      Effect.mapError((cause) => failed(`GitHub didn't answer: ${cause.message}`, cause)),
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(
              explained("Your GitHub isn't connected, so the step can't run on GitHub Actions.", {
                fix: "Connect GitHub in Settings → Connections, then retry the run.",
              }),
            )
          : Effect.succeed(value),
      ),
    );

    /** The GitHub repository the folder comes from. */
    const repositoryOf = (projectId: string) =>
      Effect.gen(function* () {
        const notGitHub = explained("This folder doesn't come from a GitHub repository.", {
          fix: "Run steps on GitHub Actions from a folder added from GitHub.",
        });
        const { userId } = yield* owner;
        const driveId = driveOfProject(ProjectId.make(projectId), userId);
        if (driveId === null || directory._tag === "None") return yield* notGitHub;
        const role = yield* userDrives
          .access(driveId)
          .pipe(Effect.mapError((cause) => failed("Couldn't open the folder.", cause)));
        if (role === null) return yield* notGitHub;
        const remote = yield* directory.value
          .forDrive(driveId)
          .remote()
          .pipe(
            Effect.mapError((cause) => failed("Couldn't read the folder's repository.", cause)),
          );
        if (remote === null) return yield* notGitHub;
        return remote;
      });

    const githubFailure = (what: string) => (cause: { readonly message: string }) =>
      failed(`${what}: ${cause.message}`, cause);

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
          const remote = yield* repositoryOf(input.projectId);
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
          const ref = options.ref ?? remote.defaultBranch;
          const run = yield* actions
            .dispatch(yield* token, remote.repository, { ref, inputs })
            .pipe(Effect.mapError(githubFailure("GitHub Actions refused the step")));
          if (run === null)
            return yield* explained(
              `${remote.repository} doesn't have Signalbox's step workflow on its default branch, or has no ${ref}.`,
              { fix: installFix },
            );
          return run;
        }).pipe(
          Effect.withSpan("GitHubActionsRunner.dispatch", {
            attributes: { "folder.id": input.projectId },
          }),
        ),
      read: (_projectId, previous) =>
        Effect.gen(function* () {
          const access = yield* token;
          const run = yield* actions.read(access, previous).pipe(
            Effect.catchIf(
              (error) => error.status === 404,
              () => Effect.succeed(null),
            ),
            Effect.mapError(githubFailure("Couldn't read the run on GitHub Actions")),
          );
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
          const result = yield* actions
            .result(access, run)
            .pipe(Effect.mapError(githubFailure("Couldn't read the step's result")));
          return { run, outcome: outcomeOf(run, result) } satisfies ExternalRead;
        }),
      cancel: (_projectId, run) =>
        token.pipe(
          Effect.flatMap((access) => actions.cancel(access, run)),
          Effect.mapError(githubFailure("Couldn't stop the run on GitHub Actions")),
        ),
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
