import {
  type GitActionProgressEvent,
  GitManagerError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStackedAction,
  type ThreadId,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusStreamEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { DriveDirectory, type DriveHandle, projectDriveId } from "../drive/DriveDirectory.ts";
import { DrivePacks } from "../drive/DrivePacks.ts";
import {
  commitsSince,
  packForPush,
  receivePackRequest,
  receivePackResult,
} from "../drive/gitPush.ts";
import type { Oid } from "../drive/git/gitObjects.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import { remoteProjectAt, remoteThreadWorktree } from "../user/contextProjects.ts";
import * as UserContexts from "../user/UserContexts.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubPullRequest } from "./GitHubApi.ts";
import { GitHubConnection } from "./GitHubConnection.ts";

/**
 * A thread's own branch in an imported repository, as the git panel sees it
 * (#135): its status against the remote, and pushing it or opening a pull
 * request, served for the thread's working tree (`remoteThreadWorktree`).
 * Everything runs here, against the drive, with no machine: the branch is
 * pushed from the drive's packs (`drive/gitPush.ts`) with the user's GitHub
 * connection. Only the thread's branch goes to GitHub, never its auto-saves.
 *
 * The thread commits its work at the end of each turn, so there is never
 * anything to commit here. Status is recomputed while a client watches it,
 * which also picks up a pull request merged on GitHub.
 */

/** How often a watched branch's status is recomputed. */
const STATUS_INTERVAL = "30 seconds";

const PROVIDER = { kind: "github", name: "GitHub", baseUrl: "https://github.com" } as const;

const failure = (cwd: string, operation: string, detail: string) =>
  new GitManagerError({ operation, cwd, detail });

type Status = {
  readonly local: VcsStatusLocalResult;
  readonly remote: VcsStatusRemoteResult | null;
};

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
  }
>()("@signalbox/cloud/github/GitHubBranches") {}

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const connection = yield* GitHubConnection;
  const contexts = yield* UserContexts.UserContexts;
  const threads = yield* CloudThreadService.CloudThreadService;
  const directory = yield* Effect.serviceOption(DriveDirectory);
  const packs = yield* Effect.serviceOption(DrivePacks);
  const drives =
    directory._tag === "Some" && packs._tag === "Some"
      ? { directory: directory.value, packs: packs.value }
      : null;
  // Working trees whose branch just moved, so every watcher recomputes at once.
  const moved = yield* PubSub.unbounded<string>();

  const remoteProjects = Effect.orDie(contexts.remoteProjects);

  /** What `cwd` names: an imported project, and the thread whose working tree it is. */
  const resolve = (actor: Actor, cwd: string, operation: string) =>
    Effect.gen(function* () {
      const found = remoteProjectAt(yield* remoteProjects, cwd);
      if (found === null)
        return yield* failure(cwd, operation, "This folder is not a git repository.");
      if (drives === null) return yield* failure(cwd, operation, "This cloud stores no drives.");
      const driveId = projectDriveId(actor.userId, found.project.projectId);
      const drive = drives.directory.forDrive(driveId);
      // A thread's branch follows from its id, and the drive is the user's own: only their
      // threads ever saved work there.
      const thread =
        found.threadId === null
          ? null
          : {
              id: found.threadId,
              branch: remoteThreadWorktree(found.project, found.threadId).branch,
            };
      return { ...found, drives, driveId, drive, thread };
    });

  const driveUnavailable = (cwd: string, operation: string) => () =>
    failure(cwd, operation, "The drive is unavailable right now.");

  /** The user's GitHub token, or null when not connected or GitHub is unreachable. */
  const token = connection.accessToken.pipe(
    Effect.catch((cause) =>
      Effect.as(Effect.logWarning("GitHub token unavailable", { cause }), null),
    ),
  );

  /** The thread's branch in its drive, and how many commits it has over its base. */
  const branchState = (drive: DriveHandle, threadId: string, cwd: string) =>
    Effect.gen(function* () {
      const refs = yield* drive.refs(threadId);
      const known = [refs.base, refs.main].filter((oid): oid is Oid => oid !== null);
      const ahead =
        refs.thread === null
          ? 0
          : (yield* commitsSince(drive, refs.thread, new Set(known))).commits.length;
      return { head: refs.thread, known, ahead };
    }).pipe(Effect.mapError(driveUnavailable(cwd, "status")));

  type Target = Effect.Success<ReturnType<typeof resolve>>;

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
          local: { ...local, isDefaultRef: true, refName: target.project.remote.defaultBranch },
          remote: includeRemote
            ? { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null }
            : null,
        };
      }
      const { branch } = target.thread;
      const state = yield* branchState(target.drive, target.thread.id, cwd);
      const branchLocal = { ...local, isDefaultRef: false, refName: branch };
      const userToken = includeRemote ? yield* token : null;
      if (userToken === null) return { local: branchLocal, remote: null };
      const repository = target.project.remote.repository;
      const remote = yield* Effect.all(
        [
          github.api.branchHead(userToken, repository, branch),
          github.api.pullForBranch(userToken, repository, branch),
        ],
        { concurrency: 2 },
      ).pipe(Effect.option);
      if (remote._tag === "None") return { local: branchLocal, remote: null };
      const [remoteHead, pr] = remote.value;
      let aheadCount = state.ahead;
      let behindCount = 0;
      if (remoteHead !== null && state.head !== null && remoteHead !== state.head) {
        const walked = yield* commitsSince(
          target.drive,
          state.head,
          new Set([remoteHead, ...state.known]),
        ).pipe(Effect.mapError(driveUnavailable(cwd, "status")));
        if (walked.reached.has(remoteHead)) aheadCount = walked.commits.length;
        // The branch on GitHub moved on its own: pushing would drop its commits.
        else behindCount = 1;
      } else if (remoteHead !== null) {
        aheadCount = 0;
      }
      return {
        local: branchLocal,
        remote: {
          hasUpstream: remoteHead !== null,
          aheadCount,
          behindCount,
          aheadOfDefaultCount: state.ahead,
          pr: pr === null ? null : toChangeRequest(pr),
        },
      };
    });

  const status: GitHubBranches["Service"]["status"] = (actor, cwd, includeRemote) =>
    Effect.flatMap(resolve(actor, cwd, "status"), (target) => statusOf(target, cwd, includeRemote));

  const watch: GitHubBranches["Service"]["watch"] = (actor, cwd, includeRemote) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // The thread and its branch never change, so they are looked up once.
        const target = yield* resolve(actor, cwd, "status");
        const first = yield* statusOf(target, cwd, includeRemote);
        const subscription = yield* PubSub.subscribe(moved);
        const later = Stream.merge(
          Stream.fromSubscription(subscription).pipe(Stream.filter((changed) => changed === cwd)),
          Stream.fromSchedule(Schedule.spaced(STATUS_INTERVAL)),
        ).pipe(
          // A failed recomputation keeps the last status; the next one tries again.
          Stream.mapEffect(() =>
            statusOf(target, cwd, includeRemote).pipe(
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning("branch status refresh failed", { detail: error.detail }),
                  null,
                ),
              ),
            ),
          ),
          Stream.filter((next) => next !== null),
        );
        return Stream.concat(Stream.make(first), later).pipe(
          // Unchanged recomputations send nothing.
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
          Stream.map((current): VcsStatusStreamEvent => ({
            _tag: "snapshot",
            local: current.local,
            remote: current.remote,
          })),
        );
      }),
    );

  /** Pushes the thread's branch from the drive. Answers whether anything moved and if the branch is new. */
  const push = (target: Target, branch: string, threadId: string, userToken: string, cwd: string) =>
    Effect.gen(function* () {
      const repository = target.project.remote.repository;
      const state = yield* branchState(target.drive, threadId, cwd);
      if (state.head === null) {
        return yield* failure(cwd, "push", "This thread has not saved any work yet.");
      }
      const head = state.head;
      const old = yield* github.api
        .branchHead(userToken, repository, branch)
        .pipe(Effect.mapError((error) => failure(cwd, "push", error.message)));
      if (old === head) return { pushed: false, created: false };
      const packed = yield* packForPush({
        driveId: target.driveId,
        head,
        old,
        remoteHas: state.known,
      }).pipe(
        Effect.provideService(DriveDirectory, target.drives.directory),
        Effect.provideService(DrivePacks, target.drives.packs),
        Effect.mapError((error) =>
          failure(
            cwd,
            "push",
            error._tag === "PushRefused" ? error.message : "The drive is unavailable right now.",
          ),
        ),
      );
      const ref = `refs/heads/${branch}`;
      const answer = yield* github.api
        .receivePack(
          userToken,
          repository,
          receivePackRequest({ ref, old, next: head, pack: packed.pack }),
        )
        .pipe(Effect.mapError((error) => failure(cwd, "push", error.message)));
      if (answer.status !== 200) {
        return yield* failure(
          cwd,
          "push",
          answer.status === 401 || answer.status === 403 || answer.status === 404
            ? `GitHub refused the push (${answer.status}). Check the Signalbox app can write to ${repository}.`
            : `GitHub answered the push with ${answer.status}.`,
        );
      }
      const result = receivePackResult(answer.body, ref);
      if (result._tag === "refused") return yield* failure(cwd, "push", result.reason);
      return { pushed: true, created: old === null };
    });

  /** The thread's open pull request, or a new one into the default branch. */
  const openPull = (
    actor: Actor,
    target: Target,
    thread: { readonly id: ThreadId; readonly branch: string },
    userToken: string,
    cwd: string,
  ) =>
    Effect.gen(function* () {
      const { repository, defaultBranch } = target.project.remote;
      const existing = yield* github.api
        .pullForBranch(userToken, repository, thread.branch)
        .pipe(Effect.mapError((error) => failure(cwd, "pr", error.message)));
      if (existing?.state === "open") return { pr: existing, created: false };
      const title = yield* threads.threadSnapshot(actor, thread.id).pipe(
        Effect.map((snapshot) => snapshot.projection.thread.title.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const pr = yield* github.api
        .createPull(userToken, repository, {
          title: title || thread.branch,
          head: thread.branch,
          base: defaultBranch,
          body: "Opened from Signalbox.",
        })
        .pipe(Effect.mapError((error) => failure(cwd, "pr", error.message)));
      return { pr, created: true };
    });

  const runAction: GitHubBranches["Service"]["runAction"] = (actor, input) => {
    const base = { actionId: input.actionId, cwd: input.cwd, action: input.action } as const;
    const pushes = PUSHES.has(input.action);
    const opensPr = OPENS_PR.has(input.action);
    const phases = [...(pushes ? (["push"] as const) : []), ...(opensPr ? (["pr"] as const) : [])];
    let phase: "push" | "pr" | null = null;
    const run = Effect.gen(function* () {
      const events: Array<GitActionProgressEvent> = [];
      if (!pushes) {
        return yield* failure(input.cwd, "commit", "Signalbox commits each turn's work itself.");
      }
      const target = yield* resolve(actor, input.cwd, "push");
      if (target.thread === null) {
        return yield* failure(input.cwd, "push", "Open a thread to push its branch.");
      }
      const { thread } = target;
      const userToken = yield* token;
      if (userToken === null) {
        return yield* failure(
          input.cwd,
          "push",
          "Connect GitHub first: Settings › Source Control.",
        );
      }
      phase = "push";
      events.push({
        ...base,
        kind: "phase_started",
        phase: "push",
        label: `Pushing ${thread.branch}`,
      });
      const pushed = yield* push(target, thread.branch, thread.id, userToken, input.cwd);
      let pr: { readonly pr: GitHubPullRequest; readonly created: boolean } | null = null;
      if (opensPr) {
        phase = "pr";
        events.push({
          ...base,
          kind: "phase_started",
          phase: "pr",
          label: "Opening a pull request",
        });
        pr = yield* openPull(actor, target, thread, userToken, input.cwd);
      }
      yield* PubSub.publish(moved, input.cwd);
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
          branch: thread.branch,
          upstreamBranch: `origin/${thread.branch}`,
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
                title: pushed.pushed ? `Pushed ${thread.branch}` : `${thread.branch} is up to date`,
                cta: { kind: "none" },
              }
            : {
                title: pr.created
                  ? `Opened pull request #${pr.pr.number}`
                  : `Pull request #${pr.pr.number} is open`,
                cta: { kind: "open_pr", label: "View pull request", url: pr.pr.url },
              },
      };
      events.push({ ...base, kind: "action_finished", result });
      return events;
    }).pipe(
      Effect.catch((error: GitManagerError) =>
        Effect.succeed<ReadonlyArray<GitActionProgressEvent>>([
          { ...base, kind: "action_failed", phase, message: error.detail },
        ]),
      ),
    );
    const started: GitActionProgressEvent = { ...base, kind: "action_started", phases };
    return Stream.concat(
      Stream.make(started),
      Stream.unwrap(Effect.map(run, (events) => Stream.fromIterable(events))),
    );
  };

  return GitHubBranches.of({ status, watch, runAction });
});

export const layer = Layer.effect(GitHubBranches, make);
