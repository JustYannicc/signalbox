import {
  GitCommandError,
  type OrchestrationV2ThreadBoundedSnapshot,
  type ThreadId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsRef,
} from "@t3tools/contracts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import type { Actor } from "../thread/ThreadAccess.ts";
import {
  driveOfProject,
  driveOfRoot,
  driveRoot,
  threadWorktreeAt,
} from "../user/contextProjects.ts";
import { GitHub } from "./GitHub.ts";
import { GitHubConnection } from "./GitHubConnection.ts";

const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;

const notARepository: VcsListRefsResult = {
  refs: [],
  isRepo: false,
  hasPrimaryRemote: false,
  nextCursor: null,
  totalCount: 0,
};

class RefKey extends Data.Class<{ readonly repository: string; readonly token: string }> {}

export const makeGitHubRefs = (access: {
  readonly drive: (driveId: string) => Effect.Effect<SignalboxDriveRole | null, unknown>;
  readonly threadSnapshot: (
    actor: Actor,
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadBoundedSnapshot, unknown>;
}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const connection = yield* GitHubConnection;
    const directory = yield* Effect.serviceOption(DriveDirectory);
    const refPages = yield* Cache.makeWith(
      (key: RefKey) => github.api.listRefs(key.token, key.repository),
      {
        capacity: 16,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value !== null ? "15 seconds" : Duration.zero,
      },
    );

    return (
      actor: Actor,
      input: VcsListRefsInput,
    ): Effect.Effect<VcsListRefsResult, GitCommandError> =>
      Effect.gen(function* () {
        const fail = (detail: string) =>
          new GitCommandError({
            operation: "vcs.listRefs",
            command: "list refs",
            cwd: input.cwd,
            detail,
          });
        const worktree = threadWorktreeAt(input.cwd);
        const driveId = worktree?.driveId ?? driveOfRoot(input.cwd, actor.userId);
        if (driveId === null || directory._tag === "None") return notARepository;
        const role = yield* access
          .drive(driveId)
          .pipe(Effect.mapError(() => fail("The drive is unavailable right now.")));
        if (role === null) return yield* fail("You can't open this drive.");

        const thread =
          worktree === null
            ? null
            : yield* Effect.gen(function* () {
                const { projection } = yield* access
                  .threadSnapshot(actor, worktree.threadId)
                  .pipe(Effect.mapError(() => fail("This thread is unavailable.")));
                if (driveOfProject(projection.thread.projectId, actor.userId) !== driveId) {
                  return yield* fail("This thread does not belong to this drive.");
                }
                if (
                  projection.thread.worktreePath !== input.cwd ||
                  projection.thread.branch === null
                ) {
                  return yield* fail("This thread has no working tree here.");
                }
                return { branch: projection.thread.branch, path: projection.thread.worktreePath };
              });
        const drive = directory.value.forDrive(driveId);
        const remote = yield* drive
          .remote()
          .pipe(Effect.mapError(() => fail("The drive is unavailable right now.")));
        if (remote === null) return notARepository;

        // Revalidate repository access even for local-only pages, after checking the folder grant.
        const token = yield* connection.accessToken.pipe(
          Effect.mapError(() => fail("GitHub can't be reached right now.")),
        );
        if (token === null) return yield* fail("Connect GitHub first: Settings › Source Control.");
        const repository = yield* github.api
          .repository(token, remote.repository)
          .pipe(Effect.mapError((error) => fail(error.message)));
        if (repository === null) return yield* fail("You can't open this repository on GitHub.");
        // Search and paging reuse branch data; the repository check above still runs every time.
        const key = new RefKey({ repository: remote.repository, token });
        if (input.refresh === true) yield* Cache.invalidate(refPages, key);
        const remoteRefs = yield* Cache.get(refPages, key).pipe(
          Effect.mapError((error) => fail(error.message)),
        );
        if (remoteRefs === null) return yield* fail("You can't open this repository on GitHub.");

        const refs = yield* drive
          .refs(worktree?.threadId ?? null)
          .pipe(Effect.mapError(() => fail("The drive is unavailable right now.")));
        const local: Array<VcsRef> = [];
        if (refs.main !== null && thread?.branch !== remote.defaultBranch) {
          local.push({
            name: remote.defaultBranch,
            isRemote: false,
            current: worktree === null,
            isDefault: remote.defaultBranch === repository.default_branch,
            worktreePath: driveRoot(driveId),
          });
        }
        if (thread !== null) {
          local.push({
            name: thread.branch,
            isRemote: false,
            current: true,
            isDefault: thread.branch === repository.default_branch,
            worktreePath: thread.path,
          });
        }
        const branches = remoteRefs
          .flatMap((ref): Array<VcsRef> =>
            ref.ref.startsWith("refs/heads/") && ref.ref.length > "refs/heads/".length
              ? [
                  {
                    name: `origin/${ref.ref.slice("refs/heads/".length)}`,
                    isRemote: true,
                    remoteName: "origin",
                    current: false,
                    isDefault: ref.ref === `refs/heads/${repository.default_branch}`,
                    worktreePath: null,
                  },
                ]
              : [],
          )
          .toSorted((left, right) => left.name.localeCompare(right.name));
        const combined = [...local, ...branches];
        const all = input.includeMatchingRemoteRefs
          ? combined
          : dedupeRemoteBranchesWithLocalMatches(combined);
        const priority = (ref: VcsRef) => (ref.current ? 0 : ref.isDefault ? 1 : 2);
        const query = input.query?.toLowerCase();
        const filtered = all
          .toSorted((left, right) => priority(left) - priority(right))
          .filter((ref) =>
            input.refKind === "local"
              ? !ref.isRemote
              : input.refKind === "remote"
                ? ref.isRemote
                : true,
          )
          .filter((ref) => query === undefined || ref.name.toLowerCase().includes(query));
        const cursor = input.cursor ?? 0;
        const page = filtered.slice(
          cursor,
          cursor + (input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT),
        );
        return {
          refs: page,
          isRepo: true,
          hasPrimaryRemote: true,
          totalCount: filtered.length,
          nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
        };
      });
  });
