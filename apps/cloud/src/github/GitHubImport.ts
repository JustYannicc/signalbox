import {
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DriveDirectory, projectDriveId } from "../drive/DriveDirectory.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { githubWorkspaceRoot } from "../user/contextProjects.ts";
import * as UserContexts from "../user/UserContexts.ts";
import { GitHub } from "./GitHub.ts";
import { type GitHubRepository, parseRepository } from "./GitHubApi.ts";
import { GitHubConnection } from "./GitHubConnection.ts";

/**
 * Importing a GitHub repository as a drive (#135), through the environment
 * protocol's own source-control RPCs, so the existing "Add project" flow
 * works unchanged: discovery says whether GitHub is connected, lookup checks
 * a repository, and `projectClone.start` registers it. Nothing is cloned
 * here: the remote stays the drive's home, and each thread's first turn
 * fetches what it needs onto its machine.
 *
 * Imported repositories land in Personal; choosing a work context comes with
 * shared drives (#140).
 */

const repositoryError = (operation: string, detail: string) =>
  new SourceControlRepositoryError({ provider: "github", operation, detail });

const toInfo = (repository: GitHubRepository): SourceControlRepositoryInfo => ({
  provider: "github",
  nameWithOwner: repository.full_name,
  url: repository.clone_url,
  sshUrl: repository.ssh_url,
});

export const makeGitHubImport = Effect.fn("makeGitHubImport")(function* (actor: Actor) {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const contexts = yield* UserContexts.UserContexts;
  const drives = yield* Effect.serviceOption(DriveDirectory);

  const discover = Effect.gen(function* () {
    const account = yield* connection.account;
    const hint =
      github.app === null
        ? "This cloud has no GitHub App configured."
        : "Connect GitHub to import its repositories.";
    return {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          status: github.app === null ? "missing" : "available",
          version: Option.none(),
          installHint: hint,
          detail: Option.none(),
          auth: {
            status: account === null ? "unauthenticated" : "authenticated",
            account: Option.fromNullishOr(account?.login),
            host: Option.some("github.com"),
            detail: account === null ? Option.some(hint) : Option.none(),
          },
        },
      ],
    } satisfies SourceControlDiscoveryResult;
  }).pipe(Effect.orDie);

  /** The repository as the user's connection sees it, or why it can't be used. */
  const find = (operation: string, input: string) =>
    Effect.gen(function* () {
      const name = parseRepository(input);
      if (name === null) {
        return yield* repositoryError(operation, "Only GitHub repositories can be added here.");
      }
      const token = yield* connection.accessToken.pipe(
        Effect.mapError(() => repositoryError(operation, "GitHub is unreachable right now.")),
      );
      if (token === null) {
        return yield* repositoryError(
          operation,
          "Connect GitHub first: Settings › Source Control.",
        );
      }
      const repository = yield* github.api
        .repository(token, name)
        .pipe(Effect.mapError((error) => repositoryError(operation, error.message)));
      if (repository === null) {
        return yield* repositoryError(
          operation,
          github.app === null
            ? `Signalbox can't see ${name}.`
            : `Signalbox can't see ${name}. Install its GitHub app there: ${github.api.installUrl(github.app.slug)}`,
        );
      }
      return repository;
    });

  const lookup = (repository: string) => Effect.map(find("lookupRepository", repository), toInfo);

  const importRepository = (
    input: ProjectCloneStartInput,
  ): Effect.Effect<ProjectCloneStartResult, SourceControlRepositoryError> =>
    Effect.gen(function* () {
      if (drives._tag === "None") {
        return yield* repositoryError("clone", "This cloud stores no drives.");
      }
      const repository = yield* find("clone", input.remoteUrl ?? input.repository ?? "");
      const workspaceRoot = githubWorkspaceRoot(repository.full_name);
      // Checked before the drive learns a remote, so an existing project's drive is never touched.
      const taken =
        (yield* Effect.orDie(contexts.contexts)).some((context) =>
          context.projectIds.includes(input.projectId),
        ) ||
        (yield* Effect.orDie(contexts.remoteProjects)).some(
          (project) => project.workspaceRoot === workspaceRoot,
        );
      if (taken) {
        return yield* repositoryError("clone", `${repository.full_name} is already a project.`);
      }
      const remote = {
        provider: "github",
        repository: repository.full_name,
        defaultBranch: repository.default_branch,
      } as const;
      // The drive learns its remote first, so no thread ever works in it as a drive of its own.
      yield* drives.value
        .forDrive(projectDriveId(actor.userId, input.projectId))
        .setRemote(remote)
        .pipe(Effect.mapError(() => repositoryError("clone", "The drive is unavailable.")));
      const added = yield* contexts
        .addRemoteProject({
          projectId: input.projectId,
          contextId: PERSONAL_CONTEXT_ID,
          title: input.title,
          workspaceRoot,
          remote,
          createdAt: input.createdAt,
        })
        .pipe(Effect.orDie);
      if (!added) {
        return yield* repositoryError("clone", `${repository.full_name} is already a project.`);
      }
      return {
        projectId: input.projectId,
        cwd: workspaceRoot,
        remoteUrl: repository.clone_url,
        repository: toInfo(repository),
      };
    });

  return { discover, lookup, importRepository };
});

export type GitHubImport = Effect.Success<ReturnType<typeof makeGitHubImport>>;
