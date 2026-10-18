import {
  PublishFailureReason,
  type PublishRequest,
} from "@signalbox/runner-protocol/BranchProtocol";
import {
  CommandId,
  GitCommandError,
  type GitActionProgressEvent,
  GitManagerError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStackedAction,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  SourceControlProviderKind,
  type ThreadId,
  type VcsPullInput,
  type VcsPullResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DriveDirectory, type DriveHandle } from "../drive/DriveDirectory.ts";
import { DriveFiles } from "../drive/DriveFiles.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import { makeDriveReader } from "../drive/DriveReader.ts";
import {
  commitsSince,
  GITHUB_LIMITS,
  packForPush,
  receivePackRequest,
  receivePackResult,
} from "../drive/gitPush.ts";
import type { Oid } from "../drive/git/gitObjects.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { canWrite } from "../drive/driveAccess.ts";
import {
  driveOfProject,
  driveOfRoot,
  remoteThreadWorktree,
  threadWorktreeAt,
} from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubError, GitHubPullRequest } from "./GitHubApi.ts";
import { GitHubConnection } from "./GitHubConnection.ts";
import { makeGitHubRefs } from "./GitHubRefs.ts";
import { BranchComparisonError } from "./branchComparison.ts";
import { makeBranchReview, type ReviewTarget } from "./branchReview.ts";

/**
 * A thread's own branch in an imported repository, as the git panel sees it
 * (#135): status, publishing and pulling for the thread's working tree
 * (`remoteThreadWorktree`). Status and publishing use the drive's packs;
 * pulls go through the thread's Runner to preserve its working copy. Only the
 * thread's branch reaches GitHub, never its auto-saves.
 *
 * The thread commits its work at the end of each turn, so there is never
 * anything to commit here. Status is recomputed while a client watches it,
 * which also picks up a pull request merged on GitHub.
 *
 * `publish` is the push and pull request themselves, for the git panel
 * (`runAction`) and the thread's own agent (`drive/branchRoutes.ts`) alike,
 * failing with why in words for both.
 *
 * `review` is the diff panel's view of the branch (`branchReview.ts`), and
 * status counts the same committed changes against the branch's pull request
 * base, so the details card's totals and the panel agree.
 *
 * The pull request `publish` opens or finds is linked to the thread as
 * upstream links the one a git action opened (`source: "created"`), so the
 * thread syncs it (`thread/pullRequests/PullRequestSync.ts`).
 */

/** How often a watched branch's status is recomputed. */
const STATUS_INTERVAL = "30 seconds";
const MAX_LOCAL_STATUS_COMMITS = 100;

const PROVIDER = {
  kind: SourceControlProviderKind.make("github"),
  name: "GitHub",
  baseUrl: "https://github.com",
} as const;

const failure = (cwd: string, operation: string, detail: string) =>
  new GitManagerError({ operation, cwd, detail });

/** Why a branch wasn't published, and in which phase. */
export class BranchPublishError extends Schema.TaggedError<BranchPublishError>()(
  "BranchPublishError",
  {
    reason: PublishFailureReason,
    phase: Schema.NullOr(Schema.Literals(["push", "pr"])),
    message: Schema.String,
  },
) {}

const refusal = (
  reason: PublishFailureReason,
  message: string,
  phase: BranchPublishError["phase"] = null,
) => new BranchPublishError({ reason, phase, message });

/** Why GitHub answered `status` (0: no answer). A token it won't take is a connection gone. */
const reasonForStatus = (status: number): PublishFailureReason =>
  status === 0 || status === 429 || status >= 500
    ? "unavailable"
    : status === 401
      ? "not_connected"
      : status === 403 || status === 404
        ? "no_permission"
        : "rejected";

/** A GitHub API failure as the reason it gives the user. */
const gitHubRefusal = (phase: "push" | "pr") => (error: GitHubError) =>
  refusal(reasonForStatus(error.status), error.message, phase);

/** A push GitHub's receive-pack refused because its branch isn't where the push expected. */
const STALE_BRANCH = /non-fast-forward|cannot lock ref|but expected/;

/** What `publish` did: the branch on the remote, and its pull request when asked for one. */
export interface Published {
  readonly branch: string;
  readonly repository: string;
  readonly push: { readonly pushed: boolean; readonly created: boolean };
  readonly pr: { readonly pr: GitHubPullRequest; readonly created: boolean } | null;
}

export interface PublishInput {
  /** The thread's working tree, as `remoteThreadWorktree` names it. */
  readonly cwd: string;
  readonly openPullRequest: boolean;
  /** The pull request's title, body and draft state, when it opens a new one. */
  readonly pullRequest?: Omit<PublishRequest, "action" | "lease">;
  /** The remote branch head the thread took in, which a rewritten branch may replace. */
  readonly lease?: Oid;
}

type Status = {
  readonly local: VcsStatusLocalResult;
  readonly remote: VcsStatusRemoteResult | null;
};

/** A folder that isn't a repository: no branch, nothing to commit, push or open. */
const NOT_A_REPOSITORY: Status = {
  local: {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  },
  remote: null,
};

const snapshotOf = (status: Status): VcsStatusStreamEvent => ({
  _tag: "snapshot",
  local: status.local,
  remote: status.remote,
});

const toChangeRequest = (pr: GitHubPullRequest): VcsStatusRemoteResult["pr"] => ({
  number: pr.number,
  title: pr.title,
  url: pr.url,
  baseRef: pr.baseRef,
  headRef: pr.headRef,
  state: pr.state,
  isDraft: pr.isDraft,
  updatedAt: pr.updatedAt,
});

const PUSHES: ReadonlySet<GitStackedAction> = new Set([
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
const OPENS_PR: ReadonlySet<GitStackedAction> = new Set(["create_pr", "commit_push_pr"]);

export class GitHubBranches extends Context.Service<
  GitHubBranches,
  {
    readonly listRefs: (
      actor: Actor,
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly status: (
      actor: Actor,
      cwd: string,
      includeRemote: boolean,
    ) => Effect.Effect<Status, GitManagerError>;
    /** The status now, then again whenever it changes, until the subscriber leaves. */
    readonly watch: (
      actor: Actor,
      cwd: string,
      includeRemote: boolean,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerError>;
    readonly runAction: (
      actor: Actor,
      input: GitRunStackedActionInput,
    ) => Stream.Stream<GitActionProgressEvent, GitManagerError>;
    /** The diff panel's sources for a thread's working tree: its committed and unsaved changes. */
    readonly review: (
      actor: Actor,
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    /** Pushes a thread's branch, and opens its pull request when asked. */
    readonly publish: (
      actor: Actor,
      input: PublishInput,
    ) => Effect.Effect<Published, BranchPublishError>;
    /** Pulls the owner-selected head of the thread's own remote branch into its drive. */
    readonly pull: (
      actor: Actor,
      input: VcsPullInput,
    ) => Effect.Effect<VcsPullResult, GitCommandError>;
  }
>()("@signalbox/cloud/github/GitHubBranches") {}

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const userDrives = yield* UserDrives.UserDrives;
  const threads = yield* CloudThreadService.CloudThreadService;
  const listRefs = yield* makeGitHubRefs({
    drive: userDrives.access,
    threadSnapshot: threads.threadSnapshot,
  });
  const crypto = yield* Crypto.Crypto;
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const packs = yield* Effect.serviceOption(DrivePacks);
  const drives =
    directory._tag === "Some" && packs._tag === "Some"
      ? { directory: directory.value, packs: packs.value }
      : null;
  const driveFiles = yield* Effect.serviceOption(DriveFiles);
  const branchReview =
    driveFiles._tag === "Some"
      ? makeBranchReview({ api: github.api, files: driveFiles.value })
      : null;
  // Working trees whose branch just moved, so every watcher recomputes at once.
  const moved = yield* PubSub.unbounded<string>();

  /**
   * Links the branch's pull request to its thread. Never fails: the push
   * already succeeded, and a link that can't be made now is made by the next
   * publish. A link the thread has is a no-op there.
   */
  const linkPullRequest = (
    actor: Actor,
    threadId: ThreadId,
    pr: GitHubPullRequest,
    repository: string,
  ) =>
    Effect.gen(function* () {
      const uuid = yield* Effect.orDie(crypto.randomUUIDv4());
      yield* threads.dispatchCommand(actor, {
        type: "thread.pull-request.link",
        commandId: CommandId.make(`cloud:pr-link:${threadId}:${uuid}`),
        threadId,
        host: github.api.host,
        repository,
        number: pr.number,
        url: pr.url,
        source: "created",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("linking a thread's pull request failed", { threadId, cause }),
      ),
      Effect.withSpan("GitHubBranches.linkPullRequest", {
        attributes: { "person.id": actor.userId, "thread.id": threadId },
      }),
    );

  const driveUnavailable = () => refusal("unavailable", "The drive is unavailable right now.");

  const driveReadFailed = (cwd: string, cause: unknown) =>
    Effect.logError("drive read failed", { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          failure(cwd, "review.getDiffPreview", "The drive is unavailable right now. Try again."),
        ),
      ),
    );

  const driveUnreadable = (cause: unknown) =>
    Effect.as(Effect.logWarning("branch changes unavailable", { cause }), {
      branchChangesError: "The drive is unavailable right now.",
    });

  const notARepository = refusal("not_a_repository", "This folder is not a git repository.");

  /** A refusal as the git panel's status reads it. */
  const asManagerError = (cwd: string, operation: string) => (error: BranchPublishError) =>
    failure(cwd, operation, error.message);

  const pullError = (cwd: string, detail: string) =>
    new GitCommandError({
      operation: "GitHubBranches.pull",
      command: "git pull --ff-only",
      cwd,
      detail,
    });

  /**
   * What `cwd` names: a drive backed by a remote the user can open, and the
   * thread whose working tree it is. A thread's branch follows from its id.
   */
  const resolve = (actor: Actor, cwd: string) =>
    Effect.gen(function* () {
      const worktree = threadWorktreeAt(cwd);
      const driveId = worktree?.driveId ?? driveOfRoot(cwd, actor.userId);
      if (driveId === null) return yield* notARepository;
      if (drives === null)
        return yield* refusal("not_a_repository", "This cloud stores no drives.");
      const role = yield* userDrives.access(driveId).pipe(Effect.mapError(driveUnavailable));
      if (role === null) return yield* refusal("no_permission", "You can't open this drive.");
      const drive = drives.directory.forDrive(driveId);
      const remote = yield* drive.remote().pipe(Effect.mapError(driveUnavailable));
      if (remote === null) return yield* notARepository;
      const thread =
        worktree === null
          ? null
          : {
              id: worktree.threadId,
              branch: remoteThreadWorktree(driveId, worktree.threadId).branch,
            };
      return { drives, driveId, drive, remote, writes: canWrite(role), thread };
    });

  /** The user's GitHub token, or null when not connected or GitHub is unreachable. */
  const token = connection.accessToken.pipe(
    Effect.catch((cause) =>
      Effect.as(Effect.logWarning("GitHub token unavailable", { cause }), null),
    ),
  );

  const branchState = (drive: DriveHandle, threadId: string) =>
    drive.refs(threadId).pipe(
      Effect.map((refs) => ({ head: refs.thread, refs })),
      Effect.mapError(driveUnavailable),
    );

  /** The committed thread tree and its newest auto-save, which holds live file edits. */
  const workingTreeOf = (target: Target, state: Effect.Success<ReturnType<typeof branchState>>) =>
    Effect.gen(function* () {
      if (state.refs.wip === null) return [];
      const reader = yield* makeDriveReader(target.driveId).pipe(
        Effect.provideService(DriveDirectory, target.drives.directory),
        Effect.provideService(DrivePacks, target.drives.packs),
      );
      const before = yield* reader.treeOf(state.head);
      const after = yield* reader.treeOf(state.refs.wip);
      return yield* reader.changes(before, after);
    });

  /** Counts remote ancestry directly, adding only proven unpublished commits on a linear chain. */
  const compareWithRemote = (
    target: Target,
    state: Effect.Success<ReturnType<typeof branchState>>,
    userToken: string,
    remoteHead: Oid,
    cwd: string,
    known: ReadonlyArray<Oid>,
  ) =>
    Effect.gen(function* () {
      if (state.head === remoteHead) return { aheadCount: 0, behindCount: 0 };
      if (state.head === null) return null;
      const local = yield* commitsSince(
        target.drive,
        state.head,
        new Set([remoteHead, ...known]),
      ).pipe(Effect.mapError(() => failure(cwd, "status", "The drive is unavailable right now.")));
      if (
        local.reached.has(remoteHead) &&
        local.commits.every((commit) => commit.parents.length === 1)
      ) {
        return { aheadCount: local.commits.length, behindCount: 0 };
      }
      let cursor = state.head;
      for (let unpublished = 0; unpublished <= MAX_LOCAL_STATUS_COMMITS; unpublished++) {
        const comparison = yield* github.api.compare(
          userToken,
          target.remote.repository,
          cursor,
          remoteHead,
        );
        if (comparison !== null) {
          return {
            aheadCount: unpublished + comparison.behindBy,
            behindCount: comparison.aheadBy,
          };
        }
        if (yield* github.api.hasCommit(userToken, target.remote.repository, cursor)) return null;
        // The drive keeps imported history one commit deep. A single-parent chain to a
        // GitHub-known commit proves the counts without needing that commit's ancestors.
        // An unpublished merge needs a wider graph proof, so its remote status stays unknown.
        const [commit] = yield* target.drive
          .commits([cursor])
          .pipe(
            Effect.mapError(() => failure(cwd, "status", "The drive is unavailable right now.")),
          );
        if (commit === undefined || commit.parents.length !== 1) return null;
        cursor = commit.parents[0]!;
      }
      return null;
    }).pipe(Effect.catchTags({ GitHubError: () => Effect.succeed(null) }));

  type Target = Effect.Success<ReturnType<typeof resolve>>;

  /** A thread's branch reads only for someone who can see the thread: a private one stays invisible. */
  const visible = (actor: Actor, target: Target) =>
    target.thread === null
      ? Effect.void
      : threads.threadSnapshot(actor, target.thread.id).pipe(
          Effect.mapError(() => refusal("no_permission", "This thread is unavailable.")),
          Effect.flatMap(({ projection }) =>
            driveOfProject(projection.thread.projectId, actor.userId) === target.driveId
              ? Effect.void
              : Effect.fail(refusal("no_permission", "This thread is unavailable.")),
          ),
        );

  const reviewTargetOf = (target: Target, thread: NonNullable<Target["thread"]>): ReviewTarget => ({
    driveId: target.driveId,
    drive: target.drive,
    repository: target.remote.repository,
    defaultBranch: target.remote.defaultBranch,
    thread,
  });

  /** A resolved working tree's status: the drive's branch, and GitHub's side when asked. */
  const statusOf = (target: Target, cwd: string, includeRemote: boolean) =>
    Effect.gen(function* () {
      const local = {
        isRepo: true,
        sourceControlProvider: PROVIDER,
        hasPrimaryRemote: true,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      } as const;
      if (target.thread === null) {
        return {
          local: { ...local, isDefaultRef: true, refName: target.remote.defaultBranch },
          remote: includeRemote
            ? { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null }
            : null,
        };
      }
      const { branch } = target.thread;
      const state = yield* branchState(target.drive, target.thread.id).pipe(
        Effect.mapError(asManagerError(cwd, "status")),
      );
      const changed = yield* workingTreeOf(target, state).pipe(
        Effect.mapError(() => failure(cwd, "status", "The drive is unavailable right now.")),
      );
      const workingTree = {
        files: changed.map(({ path }) => ({ path, insertions: 0, deletions: 0 })),
        insertions: 0,
        deletions: 0,
      };
      const branchLocal = {
        ...local,
        isDefaultRef: false,
        refName: branch,
        hasWorkingTreeChanges: changed.length > 0,
        workingTree,
      };
      // A thread's autosave is local state, so read it before any GitHub request.
      // Committed comparison totals below need GitHub and report why when unavailable.
      const uncounted = (branchChangesError: string) => ({
        local: includeRemote ? { ...branchLocal, branchChangesError } : branchLocal,
        remote: null,
      });
      const userToken = includeRemote ? yield* token : null;
      if (userToken === null) return uncounted("Connect GitHub first: Settings › Source Control.");
      const repository = target.remote.repository;
      const remote = yield* Effect.all(
        [
          github.api.repository(userToken, repository),
          github.api.branchHead(userToken, repository, branch),
          github.api.pullForBranch(userToken, repository, branch),
          target.remote.mode === "source"
            ? github.api.branchHead(userToken, repository, target.remote.defaultBranch)
            : Effect.succeed(null),
        ],
        { concurrency: 3 },
      ).pipe(Effect.option);
      if (remote._tag === "None") return uncounted("GitHub can't be reached right now.");
      const [readable, remoteHead, pr, sourceDefaultHead] = remote.value;
      // Totals come from caches, so the reader's access to the repository is checked each time.
      if (readable === null) return uncounted("You can't open this repository on GitHub.");
      // What the branch would merge: its committed work against its pull request's base.
      const counted =
        branchReview === null
          ? { branchChangesError: "This cloud stores no drives to count changes in." }
          : yield* branchReview
              .totals(
                reviewTargetOf(target, target.thread),
                userToken,
                pr?.baseRef ?? target.remote.defaultBranch,
              )
              .pipe(
                Effect.map((branchChanges) => ({ branchChanges })),
                Effect.catchTags({
                  BranchComparisonError: (error) =>
                    Effect.succeed({ branchChangesError: error.message }),
                  DriveReadError: (error) => Effect.succeed({ branchChangesError: error.message }),
                  DriveObjectError: (cause) => driveUnreadable(cause),
                  DrivePackError: (cause) => driveUnreadable(cause),
                }),
              );
      // Source-mode main and base are local. Only checked remote commits and GitHub's
      // current default head can stop the walk there.
      const known = (
        target.remote.mode === "source"
          ? [sourceDefaultHead, ...state.refs.shallow]
          : [state.refs.base, state.refs.main, ...state.refs.shallow]
      ).filter((oid): oid is Oid => oid !== null);
      const aheadOfDefaultCount =
        state.head === null
          ? 0
          : (yield* commitsSince(target.drive, state.head, new Set(known)).pipe(
              Effect.mapError(() => failure(cwd, "status", "The drive is unavailable right now.")),
            )).commits.length;
      const relation =
        remoteHead === null
          ? { aheadCount: aheadOfDefaultCount, behindCount: 0 }
          : yield* compareWithRemote(target, state, userToken, remoteHead, cwd, known).pipe(
              Effect.mapError(() => failure(cwd, "status", "The drive is unavailable right now.")),
            );
      if (relation === null) return { local: { ...branchLocal, ...counted }, remote: null };
      return {
        local: { ...branchLocal, ...counted },
        remote: {
          hasUpstream: remoteHead !== null,
          aheadCount: relation.aheadCount,
          behindCount: relation.behindCount,
          aheadOfDefaultCount,
          pr: pr === null ? null : toChangeRequest(pr),
        },
      };
    });

  /**
   * `cwd`'s working tree, or null when it isn't a repository (Scratch, a context, a drive
   * without a remote). The git panel reads that as a status, the way a self-hosted server
   * answers a plain folder, so clients hide version control there instead of failing.
   */
  const resolveRepository = (actor: Actor, cwd: string) =>
    resolve(actor, cwd).pipe(
      Effect.tap((target) => visible(actor, target)),
      Effect.catchIf(
        (error) => error.reason === "not_a_repository",
        () => Effect.succeed(null),
      ),
      Effect.mapError(asManagerError(cwd, "status")),
    );

  const status: GitHubBranches["Service"]["status"] = (actor, cwd, includeRemote) =>
    Effect.flatMap(resolveRepository(actor, cwd), (target) =>
      target === null ? Effect.succeed(NOT_A_REPOSITORY) : statusOf(target, cwd, includeRemote),
    );

  /**
   * A watched status, again. Access can be taken away while someone watches,
   * so the drive and the thread are checked each time, and losing either ends
   * the watch. A failure that may pass keeps the last status (null) for the
   * next try.
   */
  const recompute = (actor: Actor, cwd: string, includeRemote: boolean) =>
    resolve(actor, cwd).pipe(
      Effect.tap((current) => visible(actor, current)),
      Effect.flatMap((current) =>
        statusOf(current, cwd, includeRemote).pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning("branch status refresh failed", { detail: error.detail }),
              null,
            ),
          ),
        ),
      ),
      Effect.catchTags({
        BranchPublishError: (error) =>
          error.reason === "not_a_repository"
            ? Effect.succeed(NOT_A_REPOSITORY)
            : error.reason === "unavailable"
              ? Effect.as(
                  Effect.logWarning("branch status refresh failed", { detail: error.message }),
                  null,
                )
              : Effect.fail(asManagerError(cwd, "status")(error)),
      }),
    );

  const watch: GitHubBranches["Service"]["watch"] = (actor, cwd, includeRemote) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const target = yield* resolveRepository(actor, cwd);
        if (target === null) {
          // Nothing turns a folder into a repository here, so the answer holds.
          return Stream.concat(Stream.make(snapshotOf(NOT_A_REPOSITORY)), Stream.never);
        }
        const first = yield* statusOf(target, cwd, includeRemote);
        const subscription = yield* PubSub.subscribe(moved);
        const later = Stream.merge(
          Stream.fromSubscription(subscription).pipe(Stream.filter((changed) => changed === cwd)),
          Stream.fromSchedule(Schedule.spaced(STATUS_INTERVAL)),
        ).pipe(
          Stream.mapEffect(() => recompute(actor, cwd, includeRemote)),
          Stream.filter((next) => next !== null),
        );
        return Stream.concat(Stream.make(first), later).pipe(
          // Unchanged recomputations send nothing.
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
          Stream.map(snapshotOf),
        );
      }),
    );

  const review: GitHubBranches["Service"]["review"] = (actor, input) =>
    Effect.gen(function* () {
      const generatedAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
      const target = yield* resolveRepository(actor, input.cwd);
      // A folder, or a drive's own root: nothing of a branch to compare.
      if (target === null || target.thread === null || branchReview === null) {
        return { cwd: input.cwd, generatedAt, sources: [] };
      }
      const fail = (detail: string) =>
        Effect.fail(failure(input.cwd, "review.getDiffPreview", detail));
      const userToken = yield* token;
      if (userToken === null)
        return yield* fail("Connect GitHub first: Settings › Source Control.");
      // Cached merge bases and files still need the reader's current repository access.
      const { repository, defaultBranch } = target.remote;
      const readable = yield* github.api
        .repository(userToken, repository)
        .pipe(
          Effect.mapError((error) => failure(input.cwd, "review.getDiffPreview", error.message)),
        );
      if (readable === null) return yield* fail("You can't open this repository on GitHub.");
      const thread = target.thread;
      const pullRequestBase = github.api.pullForBranch(userToken, repository, thread.branch).pipe(
        Effect.map((pr) => pr?.baseRef ?? defaultBranch),
        Effect.mapError((error) => new BranchComparisonError({ message: error.message })),
      );
      const sources = yield* branchReview.sources(
        reviewTargetOf(target, thread),
        userToken,
        input,
        pullRequestBase,
      );
      return { cwd: input.cwd, generatedAt, sources };
    }).pipe(
      Effect.catchTags({
        BranchComparisonError: (error) =>
          Effect.fail(failure(input.cwd, "review.getDiffPreview", error.message)),
        DriveReadError: (error) =>
          Effect.fail(failure(input.cwd, "review.getDiffPreview", error.message)),
        DriveObjectError: (cause) => driveReadFailed(input.cwd, cause),
        DrivePackError: (cause) => driveReadFailed(input.cwd, cause),
      }),
      Effect.mapError(
        (error) =>
          new GitCommandError({
            operation: "review.getDiffPreview",
            command: "drive compare",
            cwd: input.cwd,
            detail: error.detail,
          }),
      ),
    );

  /** Pushes the thread's branch from the drive. Answers whether anything moved and if the branch is new. */
  const push = (
    target: Target,
    branch: string,
    threadId: string,
    userToken: string,
    lease: Oid | undefined,
  ) =>
    Effect.gen(function* () {
      const repository = target.remote.repository;
      const [refs, old, sourceDefaultHead] = yield* Effect.all(
        [
          target.drive.refs(threadId).pipe(Effect.mapError(driveUnavailable)),
          github.api
            .branchHead(userToken, repository, branch)
            .pipe(Effect.mapError(gitHubRefusal("push"))),
          target.remote.mode === "source"
            ? github.api
                .branchHead(userToken, repository, target.remote.defaultBranch)
                .pipe(Effect.mapError(gitHubRefusal("push")))
            : Effect.succeed(null),
        ],
        { concurrency: 3 },
      );
      if (refs.thread === null) {
        return yield* refusal("nothing_saved", "This thread has not saved any work yet.");
      }
      const head = refs.thread;
      if (old === head) return { pushed: false, created: false };
      const packed = yield* packForPush({
        driveId: target.driveId,
        head,
        old,
        remoteHas: (target.remote.mode === "source"
          ? [sourceDefaultHead, ...refs.shallow]
          : [refs.base, refs.main, ...refs.shallow]
        ).filter((oid): oid is Oid => oid !== null),
        limits: GITHUB_LIMITS,
        // GitHub still checks `old` as it moves the branch, so a lease never races a push.
        force: old !== null && old === lease,
      }).pipe(
        Effect.provideService(DriveDirectory, target.drives.directory),
        Effect.provideService(DrivePacks, target.drives.packs),
        Effect.mapError((error) =>
          error._tag !== "PushRefused"
            ? driveUnavailable()
            : refusal(error.diverged === true ? "branch_conflict" : "rejected", error.message),
        ),
      );
      const ref = `refs/heads/${branch}`;
      // The pack streams from the drive as it goes: a read failing cuts the push, which isn't GitHub's doing.
      let unreadable = false;
      let sent = 0;
      const pack = packed.pack.pipe(
        Stream.tap((bytes) => Effect.sync(() => (sent += bytes.length))),
        Stream.tapError(() => Effect.sync(() => (unreadable = true))),
      );
      const request = receivePackRequest({ ref, old, next: head, pack, size: packed.size });
      const answer = yield* github.api.receivePack(userToken, repository, request.body).pipe(
        Effect.tapError(() =>
          Effect.logWarning("push cut off", { sent, size: packed.size, unreadable }),
        ),
        Effect.mapError((error) =>
          unreadable ? driveUnavailable() : gitHubRefusal("push")(error),
        ),
      );
      if (answer.status !== 200) {
        const reason = reasonForStatus(answer.status);
        return yield* refusal(
          reason,
          reason === "no_permission" || reason === "not_connected"
            ? `GitHub refused the push (${answer.status}). Check the Signalbox app can write to ${repository}.`
            : `GitHub answered the push with ${answer.status}.`,
        );
      }
      const result = receivePackResult(answer.body, ref);
      if (result._tag === "refused") {
        return yield* refusal(
          STALE_BRANCH.test(result.reason) ? "branch_conflict" : "rejected",
          result.reason,
        );
      }
      return { pushed: true, created: old === null };
    }).pipe(
      Effect.mapError(
        (error) =>
          new BranchPublishError({ reason: error.reason, message: error.message, phase: "push" }),
      ),
    );

  /** The thread's open pull request, or a new one into the default branch. */
  const openPull = (
    actor: Actor,
    target: Target,
    thread: { readonly id: ThreadId; readonly branch: string },
    userToken: string,
    details: PublishInput["pullRequest"],
  ) =>
    Effect.gen(function* () {
      const { repository, defaultBranch } = target.remote;
      const openOne = github.api.pullForBranch(userToken, repository, thread.branch).pipe(
        Effect.mapError(gitHubRefusal("pr")),
        Effect.map((found) => (found?.state === "open" ? found : null)),
      );
      const existing = yield* openOne;
      if (existing !== null) return { pr: existing, created: false };
      const title =
        details?.title?.trim() ||
        (yield* threads.threadSnapshot(actor, thread.id).pipe(
          Effect.map((snapshot) => snapshot.projection.thread.title.trim()),
          Effect.orElseSucceed(() => ""),
        ));
      return yield* github.api
        .createPull(userToken, repository, {
          title: title || thread.branch,
          head: thread.branch,
          base: defaultBranch,
          body: details?.body?.trim() || "Opened from Signalbox.",
          ...(details?.draft === true ? { draft: true } : {}),
        })
        .pipe(
          Effect.map((pr) => ({ pr, created: true })),
          // A retried call may find the pull request it opened before GitHub listed it.
          Effect.catchIf(
            (error) => error.status === 422,
            (error) =>
              Effect.flatMap(openOne, (open) =>
                open === null
                  ? Effect.fail(gitHubRefusal("pr")(error))
                  : Effect.succeed({ pr: open, created: false }),
              ),
          ),
          Effect.mapError((error) =>
            error._tag === "GitHubError" ? gitHubRefusal("pr")(error) : error,
          ),
        );
    });

  const publish: GitHubBranches["Service"]["publish"] = (actor, input) =>
    Effect.gen(function* () {
      const target = yield* resolve(actor, input.cwd);
      if (target.thread === null) {
        return yield* refusal("not_a_repository", "Open a thread to push its branch.");
      }
      if (!target.writes) {
        return yield* refusal("no_permission", "You can view this drive but not change it.");
      }
      const { thread } = target;
      const operationId = yield* Effect.orDie(crypto.randomUUIDv4());
      return yield* Effect.acquireUseRelease(
        threads
          .reservePublication(actor, thread.id, target.driveId, operationId)
          .pipe(
            Effect.mapError(() =>
              refusal("rejected", "Another Git operation is running on this thread."),
            ),
          ),
        () =>
          Effect.gen(function* () {
            const userToken = yield* connection.accessToken.pipe(
              Effect.tapError((cause) => Effect.logWarning("GitHub token unavailable", { cause })),
              Effect.mapError(() => refusal("unavailable", "GitHub can't be reached right now.")),
            );
            if (userToken === null) {
              return yield* refusal(
                "not_connected",
                "Connect GitHub first: Settings › Source Control.",
              );
            }
            // Watchers recompute only when the branch or its pull request changed.
            const pushed = yield* push(target, thread.branch, thread.id, userToken, input.lease);
            if (pushed.pushed) yield* PubSub.publish(moved, input.cwd);
            const pr = input.openPullRequest
              ? yield* openPull(actor, target, thread, userToken, input.pullRequest)
              : null;
            if (pr?.created === true) yield* PubSub.publish(moved, input.cwd);
            if (pr !== null)
              yield* linkPullRequest(actor, thread.id, pr.pr, target.remote.repository);
            return {
              branch: thread.branch,
              repository: target.remote.repository,
              push: pushed,
              pr,
            } satisfies Published;
          }).pipe(
            Effect.timeoutOption("60 seconds"),
            Effect.flatMap((result) =>
              Option.isSome(result)
                ? Effect.succeed(result.value)
                : Effect.fail(
                    refusal("unavailable", "GitHub did not finish publishing the branch in time."),
                  ),
            ),
          ),
        () =>
          threads
            .releasePublication(actor, thread.id, target.driveId, operationId)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not release the GitHub publication reservation."),
              ),
            ),
      );
    });

  // signalbox: pulls go through the durable thread Runner so its working copy can preserve WIP.
  const pull: GitHubBranches["Service"]["pull"] = (actor, input) =>
    Effect.gen(function* () {
      const target = yield* resolve(actor, input.cwd).pipe(
        Effect.mapError(() => pullError(input.cwd, "This folder is not a remote-backed thread.")),
      );
      if (target.thread === null) {
        return yield* pullError(input.cwd, "Open a remote-backed thread to pull its branch.");
      }
      if (!target.writes) {
        return yield* pullError(input.cwd, "You can view this drive but not change its files.");
      }
      const operationId = input.operationId ?? (yield* Effect.orDie(crypto.randomUUIDv4()));
      // A retry must keep the originally selected commit even if GitHub moved, deleted the
      // branch, or became unreachable after the drive applied the pull.
      let remoteHead = yield* threads
        .pullTarget(actor, target.thread.id, target.driveId, operationId, target.thread.branch)
        .pipe(Effect.mapError(() => pullError(input.cwd, "This thread is not available.")));
      if (remoteHead === null) {
        const owner = yield* threads
          .pullOwner(actor, target.thread.id, target.driveId)
          .pipe(Effect.mapError(() => pullError(input.cwd, "This thread is not available.")));
        if (owner === null) return yield* pullError(input.cwd, "This thread is not available.");
        if (owner.userId !== actor.userId) {
          return yield* pullError(input.cwd, "Only the thread owner can pull its remote branch.");
        }
        const ownerToken = yield* connection.accessToken.pipe(
          Effect.mapError(() =>
            pullError(input.cwd, "The thread owner's GitHub connection is unavailable."),
          ),
        );
        if (ownerToken === null) {
          return yield* pullError(
            input.cwd,
            "Connect GitHub on the account that owns this thread.",
          );
        }
        remoteHead = yield* github.api
          .branchHead(ownerToken, target.remote.repository, target.thread.branch)
          .pipe(Effect.mapError((error) => pullError(input.cwd, error.message)));
        if (remoteHead === null) {
          return yield* pullError(input.cwd, `GitHub has no branch named ${target.thread.branch}.`);
        }
      }
      const result = yield* threads
        .pull(actor, target.thread.id, {
          driveId: target.driveId,
          operationId,
          target: remoteHead,
          branch: target.thread.branch,
        })
        .pipe(
          Effect.mapError((error) =>
            pullError(
              input.cwd,
              error._tag === "ThreadCommandRejectedError"
                ? error.reason
                : "This thread is not available for pulling.",
            ),
          ),
        );
      if (result.outcome === "refused") {
        return yield* pullError(
          input.cwd,
          result.reason ?? "The thread's work could not be pulled.",
        );
      }
      yield* PubSub.publish(moved, input.cwd);
      return {
        status: result.outcome === "pulled" ? "pulled" : "skipped_up_to_date",
        refName: target.thread.branch,
        upstreamRef: `origin/${target.thread.branch}`,
      } satisfies VcsPullResult;
    });

  const runAction: GitHubBranches["Service"]["runAction"] = (actor, input) => {
    const base = { actionId: input.actionId, cwd: input.cwd, action: input.action } as const;
    const pushes = PUSHES.has(input.action);
    const opensPr = OPENS_PR.has(input.action);
    const phases = [...(pushes ? (["push"] as const) : []), ...(opensPr ? (["pr"] as const) : [])];
    const run = Effect.gen(function* () {
      if (!pushes) {
        return yield* refusal("rejected", "Signalbox commits each turn's work itself.");
      }
      const published = yield* publish(actor, { cwd: input.cwd, openPullRequest: opensPr });
      const { branch, pr } = published;
      const pushed = published.push;
      const result: GitRunStackedActionResult = {
        action: input.action,
        branch: { status: "skipped_not_requested" },
        commit: {
          status: input.action.startsWith("commit")
            ? "skipped_no_changes"
            : "skipped_not_requested",
        },
        push: {
          status: pushed.pushed ? "pushed" : "skipped_up_to_date",
          branch,
          upstreamBranch: `origin/${branch}`,
          setUpstream: pushed.created,
        },
        pr:
          pr === null
            ? { status: "skipped_not_requested" }
            : {
                status: pr.created ? "created" : "opened_existing",
                url: pr.pr.url,
                number: pr.pr.number,
                baseBranch: pr.pr.baseRef,
                headBranch: pr.pr.headRef,
                title: pr.pr.title,
              },
        toast:
          pr === null
            ? {
                title: pushed.pushed ? `Pushed ${branch}` : `${branch} is up to date`,
                cta: { kind: "none" },
              }
            : {
                title: pr.created
                  ? `Opened pull request #${pr.pr.number}`
                  : `Pull request #${pr.pr.number} is open`,
                cta: { kind: "open_pr", label: "View pull request", url: pr.pr.url },
              },
      };
      return [
        ...phases.map((phase): GitActionProgressEvent => ({
          ...base,
          kind: "phase_started",
          phase,
          label: phase === "push" ? `Pushing ${branch}` : "Opening a pull request",
        })),
        { ...base, kind: "action_finished", result },
      ] satisfies ReadonlyArray<GitActionProgressEvent>;
    }).pipe(
      Effect.catch((error: BranchPublishError) =>
        Effect.succeed<ReadonlyArray<GitActionProgressEvent>>([
          { ...base, kind: "action_failed", phase: error.phase, message: error.message },
        ]),
      ),
    );
    const started: GitActionProgressEvent = { ...base, kind: "action_started", phases };
    return Stream.concat(
      Stream.make(started),
      Stream.unwrap(Effect.map(run, (events) => Stream.fromIterable(events))),
    );
  };

  return GitHubBranches.of({ listRefs, status, watch, runAction, review, publish, pull });
});

export const layer = Layer.effect(GitHubBranches, make);
