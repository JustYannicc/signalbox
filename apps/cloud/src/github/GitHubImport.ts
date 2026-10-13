import {
  type ProjectCloneStartInput,
  type ProjectCloneStartResult,
  type SourceControlDiscoveryResult,
  type SourceControlRepositoryInfo,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { sharedDriveId } from "../drive/driveAccess.ts";
import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { driveRoot, projectIdForDrive } from "../user/contextProjects.ts";
import * as UserDriveIndex from "../user/UserDriveIndex.ts";
import * as UserStore from "../user/UserStore.ts";
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
 * An imported repository is a drive like any shared drive (`drive/`), with
 * the user as its manager, so it can be shared, and with its remote recorded
 * on it. It lands in Personal for now; picking a context is still to come.
 */

const repositoryError = (operation: string, detail: string) =>
  new SourceControlRepositoryError({ provider: "github", operation, detail });

const toInfo = (repository: GitHubRepository): SourceControlRepositoryInfo => ({
  provider: "github",
  nameWithOwner: repository.full_name,
  url: repository.clone_url,
  sshUrl: repository.ssh_url,
});

export const makeGitHubImport = Effect.fn("makeGitHubImport")(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const store = yield* UserStore.UserStore;
  const index = yield* UserDriveIndex.UserDriveIndex;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
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

  /** The user as a drive member. */
  const me = Effect.gen(function* () {
    const profile = yield* Effect.orDie(store.profile);
    if (profile === null) return yield* repositoryError("clone", "Sign in again to import.");
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    return { userId: profile.id, email: profile.email, name: name || null };
  });

  const importRepository = (
    input: ProjectCloneStartInput,
  ): Effect.Effect<ProjectCloneStartResult, SourceControlRepositoryError> =>
    Effect.gen(function* () {
      if (drives._tag === "None") {
        return yield* repositoryError("clone", "This cloud stores no drives.");
      }
      const repository = yield* find("clone", input.remoteUrl ?? input.repository ?? "");
      const imported = yield* Effect.orDie(
        sql<{ readonly drive_id: string }>`SELECT drive_id FROM github_drives
          WHERE repository = ${repository.full_name}`,
      );
      if (imported.length > 0) {
        return yield* repositoryError("clone", `${repository.full_name} is already a project.`);
      }
      const owner = yield* me;
      const key = (yield* Effect.orDie(crypto.randomUUIDv4)).replaceAll("-", "");
      const driveId = sharedDriveId(PERSONAL_CONTEXT_ID, key);
      const drive = drives.value.forDrive(driveId);
      const unavailable = () => repositoryError("clone", "Drives are unavailable right now.");
      // The drive learns its remote before anyone is in it, so no thread ever works in it
      // as a drive of its own.
      yield* drive
        .setRemote({
          provider: "github",
          repository: repository.full_name,
          defaultBranch: repository.default_branch,
        })
        .pipe(Effect.mapError(unavailable));
      yield* drive
        .setup({ name: repository.full_name, members: [{ ...owner, role: "manager" }] })
        .pipe(Effect.mapError(unavailable));
      // Listed at once, from the drive's own pending delivery, which then changes nothing.
      const entry = (yield* drive.pendingAccess().pipe(Effect.mapError(unavailable))).find(
        (pending) => pending.userId === owner.userId,
      );
      if (entry !== undefined) {
        yield* Effect.orDie(index.record({ driveId, name: repository.full_name, ...entry }));
      }
      yield* Effect.orDie(
        sql`INSERT INTO github_drives (drive_id, repository, created_at)
          VALUES (${driveId}, ${repository.full_name}, ${yield* Clock.currentTimeMillis})`,
      );
      return {
        projectId: projectIdForDrive(driveId),
        cwd: driveRoot(driveId),
        remoteUrl: repository.clone_url,
        repository: toInfo(repository),
      };
    });

  return { discover, lookup, importRepository };
});

export type GitHubImport = Effect.Success<ReturnType<typeof makeGitHubImport>>;
