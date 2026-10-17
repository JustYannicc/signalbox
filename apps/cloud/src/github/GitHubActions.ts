import { AutomationError, ProjectId, type ExternalRun } from "@t3tools/contracts";
import type {
  FolderSetGitHubLendInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { explained } from "@signalbox/automations/runLog";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { driveOfProject } from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserStore from "../user/UserStore.ts";
import { makeActionsApi, type StepResult } from "./actionsApi.ts";
import { GitHub } from "./GitHub.ts";
import { GitHubConnection } from "./GitHubConnection.ts";

/**
 * GitHub Actions for a folder: which repository its CI runs in and whose
 * GitHub it acts as. Today that's the GitHub account the user lent to the
 * folder (#641, a lend in the sense of #230). When the folder's GitHub App
 * exists (JustYannicc/executor#17 and #6), `credentials` and `tokenFor`
 * answer with it instead and `setLend` goes away: callers never see which it is.
 */

export type GitHubActionsDispatch =
  | { readonly _tag: "dispatched"; readonly run: ExternalRun }
  /** The repository has no step workflow on its default branch, or no `ref`. */
  | { readonly _tag: "no-workflow"; readonly repository: string; readonly ref: string };

export class GitHubActions extends Context.Service<
  GitHubActions,
  {
    /** Starts the step workflow on `ref` (the default branch when absent), acting as the folder's lend. */
    readonly dispatch: (
      projectId: string,
      input: {
        readonly ref: string | undefined;
        readonly inputs: Readonly<Record<string, string>>;
      },
    ) => Effect.Effect<GitHubActionsDispatch, AutomationError>;
    /** The run as it is now; null once it's gone from GitHub. */
    readonly read: (run: ExternalRun) => Effect.Effect<ExternalRun | null, AutomationError>;
    /** What the function returned, from a finished run's artifact; null when it kept none. */
    readonly result: (run: ExternalRun) => Effect.Effect<StepResult | null, AutomationError>;
    readonly cancel: (run: ExternalRun) => Effect.Effect<void, AutomationError>;
    /**
     * Lends the user's connected GitHub account to a folder's CI steps, or
     * stops lending it. Once folders have their GitHub App, there is nothing to lend.
     */
    readonly setLend: (
      input: FolderSetGitHubLendInput,
    ) => Effect.Effect<SignalboxFoldersSnapshot, UserFolders.FolderRefusedError | SqlError>;
  }
>()("@signalbox/cloud/github/GitHubActions") {}

const failed = (message: string, cause?: unknown) =>
  new AutomationError({ message, ...(cause === undefined ? {} : { cause }) });
const githubFailure = (what: string) => (cause: { readonly message: string }) =>
  failed(`${what}: ${cause.message}`, cause);

const LEND_FIX =
  "Lend your GitHub to this folder: its ⋯ menu → Lend my GitHub to CI steps. Its CI steps then run as you.";

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const userDrives = yield* UserDrives.UserDrives;
  const folders = yield* UserFolders.UserFolders;
  const users = yield* UserStore.UserStore;
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const api = makeActionsApi(github.api);

  /**
   * What calls GitHub for a repository act with: the user's connection now.
   * The folder's GitHub App, when it exists, answers per repository instead.
   */
  const tokenFor = (_repository: string) =>
    connection.accessToken.pipe(
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

  /** The GitHub repository the folder's files come from. */
  const repositoryOf = (projectId: string) =>
    Effect.gen(function* () {
      const notGitHub = explained("This folder doesn't come from a GitHub repository.", {
        fix: "Run steps on GitHub Actions from a folder added from GitHub.",
      });
      const profile = yield* users.profile.pipe(
        Effect.mapError((cause) => failed("Couldn't read the account.", cause)),
      );
      const driveId =
        profile === null ? null : driveOfProject(ProjectId.make(projectId), profile.id);
      if (driveId === null || directory._tag === "None") return yield* notGitHub;
      const role = yield* userDrives
        .access(driveId)
        .pipe(Effect.mapError((cause) => failed("Couldn't open the folder.", cause)));
      if (role === null) return yield* notGitHub;
      const remote = yield* directory.value
        .forDrive(driveId)
        .remote()
        .pipe(Effect.mapError((cause) => failed("Couldn't read the folder's repository.", cause)));
      return remote ?? (yield* notGitHub);
    });

  /**
   * Whose GitHub a folder's CI steps start as: the connection the user lent
   * to the folder whose files these are. Starting one needs the lend; a run
   * already started is still read and stopped with it after the lend ends.
   */
  const credentials = (projectId: string) =>
    Effect.gen(function* () {
      const snapshot = yield* folders.snapshot.pipe(
        Effect.mapError((cause) => failed("Couldn't read the folders.", cause)),
      );
      const folder = snapshot.folders.find((entry) => entry.files?.projectId === projectId);
      if (!folder?.githubLend)
        return yield* explained("No GitHub is lent to this folder's CI steps.", {
          why: "Steps on GitHub Actions run as someone's GitHub, and only one they lent to the folder.",
          fix: LEND_FIX,
        });
      const account = yield* connection.account.pipe(
        Effect.mapError((cause) => failed("Couldn't read your GitHub connection.", cause)),
      );
      if (account === null || account.login !== folder.githubLend.login)
        return yield* explained(
          `This folder's CI steps were lent @${folder.githubLend.login}'s GitHub, which isn't the one connected now.`,
          {
            fix: "Lend your GitHub to the folder again: its ⋯ menu → Lend my GitHub to CI steps.",
          },
        );
      return { login: account.login };
    });

  return GitHubActions.of({
    dispatch: (projectId, input) =>
      Effect.gen(function* () {
        const remote = yield* repositoryOf(projectId);
        const lent = yield* credentials(projectId);
        const ref = input.ref ?? remote.defaultBranch;
        const run = yield* api
          .dispatch(yield* tokenFor(remote.repository), remote.repository, {
            ref,
            inputs: input.inputs,
          })
          .pipe(Effect.mapError(githubFailure("GitHub Actions refused the step")));
        return run === null
          ? ({ _tag: "no-workflow", repository: remote.repository, ref } as const)
          : ({ _tag: "dispatched", run: { ...run, actingAs: lent.login } } as const);
      }).pipe(
        Effect.withSpan("GitHubActions.dispatch", { attributes: { "folder.id": projectId } }),
      ),
    read: (previous) =>
      Effect.gen(function* () {
        const run = yield* api.read(yield* tokenFor(previous.scope), previous).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.succeed(null),
          ),
          Effect.mapError(githubFailure("Couldn't read the run on GitHub Actions")),
        );
        return run === null ? null : { ...run, actingAs: previous.actingAs ?? null };
      }),
    result: (run) =>
      tokenFor(run.scope).pipe(
        Effect.flatMap((access) => api.result(access, run)),
        Effect.mapError(githubFailure("Couldn't read the step's result")),
      ),
    cancel: (run) =>
      tokenFor(run.scope).pipe(
        Effect.flatMap((access) => api.cancel(access, run)),
        Effect.mapError(githubFailure("Couldn't stop the run on GitHub Actions")),
      ),
    setLend: ({ id, lent }) =>
      Effect.gen(function* () {
        if (!lent) return yield* folders.setGitHubLend(id, null);
        const account = yield* connection.account;
        if (account === null)
          return yield* new UserFolders.FolderRefusedError({
            reason: "invalid",
            message: "Connect your GitHub first, in Settings → Connections.",
          });
        return yield* folders.setGitHubLend(id, account.login);
      }),
  });
});

/** In the user's object, beside their GitHub connection and folders. */
export const layer = Layer.effect(GitHubActions, make);
