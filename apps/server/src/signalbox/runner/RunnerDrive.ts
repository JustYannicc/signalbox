import {
  DRIVE_COMMIT_AUTHOR,
  DRIVE_MERGE_MESSAGE,
  type DriveFileChange,
  type DriveRemote,
} from "@signalbox/runner-protocol/DriveProtocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import type { DriveClient, DriveClientError } from "./RunnerDriveClient.ts";
import { type DriveRefs, makeDriveMirror } from "./RunnerDriveMirror.ts";
import { EMPTY_TREE, makeRunnerGit, RunnerGitError } from "./RunnerGit.ts";
import { makeRunnerInstructions, type RunnerInstructionsError } from "./RunnerInstructions.ts";
import { makeRunnerShortcuts } from "./RunnerShortcuts.ts";

/**
 * The thread's working directory as a checkout of its drive (#131). The
 * directory is a git repository on branch `signalbox`, mirroring its drive
 * (`RunnerDriveMirror.ts`). Everything here runs one at a time, after any
 * running auto-save.
 *
 * - `prepare` (turn start) opens the drive and restores the thread's branch
 *   and auto-save, unless this disk already holds them (it may hold newer
 *   unsaved edits, which the next save uploads).
 * - `autosave` snapshots the whole worktree as a commit on `wip`, without
 *   touching the agent's index or HEAD.
 * - `finishTurn` commits the turn, merges `main` in, saves the branch and
 *   fast-forwards `main` to it. A merge conflict stays in the worktree for the
 *   agent; `continueAfterResolution` or `abandonMerge` carries on from there.
 *
 * A drive backed by a remote repository (#135) keeps the remote as its home.
 * `prepare` first fetches the remote's default branch through the cloud, one
 * commit deep, with the turn's remote token (the machine holds no credential
 * for the remote) and mirrors the drive's `main` to it, so a new thread
 * starts from the remote's latest. `finishTurn` saves the branch and stops
 * there: the user pushes it or opens a pull request, and merging that on the
 * remote is what lands the work. Auto-saves never leave the drive.
 *
 * `prepare` also mounts the drive's shortcuts (`RunnerShortcuts.ts`) and
 * writes the instructions they bring (`RunnerInstructions.ts`), answering
 * that bundle's version so the harness session can follow it.
 */

export interface DriveCheckpoint {
  /** The branch when the turn started; null when it had no commit yet. */
  readonly start: string | null;
  readonly commit: string;
  readonly files: ReadonlyArray<DriveFileChange>;
}

export type DriveOutcome =
  | { readonly _tag: "landed"; readonly main: string }
  /** A remote-backed drive's branch, saved for the user to push. */
  | { readonly _tag: "saved"; readonly head: string }
  | { readonly _tag: "conflict"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "not_landed"; readonly reason: string };

export type RunnerDriveError = RunnerGitError | DriveClientError | PlatformError.PlatformError;

/** What a turn start left in the working directory. */
export interface PreparedDrive {
  /** The instructions the shortcuts bring; changes when they do (see `RunnerInstructions.ts`). */
  readonly instructions: string;
  /** What the thread should hear about its shortcuts. */
  readonly notices: ReadonlyArray<string>;
}

export interface RunnerDrive {
  /**
   * At each turn start: opens the drive and checks the thread's branch out,
   * first bringing a remote-backed drive's `main` up to the remote with the
   * turn's `remoteToken`, then mounts its shortcuts. Fails when their
   * instructions are too big to load.
   */
  readonly prepare: (
    remoteToken: string | null,
  ) => Effect.Effect<PreparedDrive, RunnerDriveError | RunnerInstructionsError>;
  /** Starts an auto-save, or queues one behind the running one. Never fails. */
  readonly autosave: Effect.Effect<void>;
  /** Waits for running and queued auto-saves. */
  readonly flush: Effect.Effect<void>;
  readonly finishTurn: (input: {
    readonly message: string;
  }) => Effect.Effect<
    { readonly checkpoint: DriveCheckpoint | null; readonly outcome: DriveOutcome },
    RunnerDriveError
  >;
  readonly continueAfterResolution: Effect.Effect<DriveOutcome, RunnerDriveError>;
  readonly abandonMerge: Effect.Effect<DriveOutcome, RunnerDriveError>;
}

const BRANCH = "refs/heads/signalbox";
/** The remote's head as last fetched. */
const REMOTE_REF = "refs/drive/remote";
const CONFIG = [
  ["user.name", DRIVE_COMMIT_AUTHOR.name],
  ["user.email", DRIVE_COMMIT_AUTHOR.email],
  ["gc.auto", "0"],
  ["core.quotepath", "false"],
] as const;
const RECONCILE_ATTEMPTS = 5;
const CONFLICT_MARKER = /^(<<<<<<<|>>>>>>>) /m;

const commitTitle = (message: string) =>
  message.trim().split("\n")[0]!.trim().slice(0, 72) || "Turn";

export const makeRunnerDrive = Effect.fn("makeRunnerDrive")(function* (input: {
  /** The thread's working directory. */
  readonly cwd: string;
  readonly client: DriveClient;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const git = yield* makeRunnerGit(input.cwd);
  const gitDir = path.join(input.cwd, ".git");
  const drive = yield* makeDriveMirror({ gitDir, git, client: input.client });
  const shortcuts = yield* makeRunnerShortcuts({ cwd: input.cwd, git, client: input.client });
  const instructions = yield* makeRunnerInstructions({ cwd: input.cwd });
  const lock = yield* Semaphore.make(1);
  /** HEAD when the turn started: the base of its checkpoint. */
  let turnStart: string | null = null;
  /** Files the last merge left conflicted. */
  let conflicted: ReadonlyArray<string> = [];
  /** The remote the drive is backed by, once read; a drive's remote never changes. */
  let remote: DriveRemote | null | undefined = undefined;

  /** The worktree as a tree, built in a scratch index so the agent's index and HEAD stay put. */
  const snapshotTree = (head: string | null) =>
    Effect.gen(function* () {
      const scratch = path.join(gitDir, "signalbox-snapshot-index");
      const env = { GIT_INDEX_FILE: scratch };
      const index = path.join(gitDir, "index");
      // Starting from the agent's index keeps git's stat cache: only changed files are hashed.
      if (yield* fs.exists(index)) yield* fs.copyFile(index, scratch);
      else yield* git.run(head === null ? ["read-tree", "--empty"] : ["read-tree", head], { env });
      yield* git.run(["add", "-A"], { env });
      return (yield* git.run(["write-tree"], { env })).trim();
    });

  const treeOf = (commit: string | null) =>
    commit === null
      ? Effect.succeed(EMPTY_TREE)
      : git.run(["rev-parse", `${commit}^{tree}`]).pipe(Effect.map((out) => out.trim()));

  const saveWip = Effect.gen(function* () {
    // Mid-merge the worktree holds conflict markers; the last save before the merge stands.
    if ((yield* git.resolve("MERGE_HEAD")) !== null) return;
    const head = yield* git.resolve("HEAD");
    const tree = yield* snapshotTree(head);
    if (tree === (yield* treeOf(drive.known().wip ?? head))) return;
    const parent = head === null ? [] : ["-p", head];
    const commit = (yield* git.run(["commit-tree", tree, ...parent, "-m", "Auto-save"])).trim();
    const refused = yield* drive.saveWip(commit);
    if (refused !== null) yield* Effect.logWarning("the drive refused an auto-save", { refused });
  });

  let saving: Deferred.Deferred<void> | null = null;
  let dirty = false;

  const drain = (done: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      while (true) {
        dirty = false;
        yield* lock
          .withPermits(1)(saveWip)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-save failed", Cause.pretty(cause)),
            ),
          );
        if (!dirty) return;
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          saving = null;
          // A save asked for after the last check, while this one finished.
          const again = dirty;
          return Deferred.succeed(done, undefined).pipe(
            Effect.andThen(again ? autosave : Effect.void),
          );
        }),
      ),
    );

  const autosave: Effect.Effect<void> = Effect.suspend(() => {
    if (saving !== null) {
      dirty = true;
      return Effect.void;
    }
    const done = Deferred.makeUnsafe<void>();
    saving = done;
    return drain(done).pipe(Effect.forkIn(scope), Effect.asVoid);
  });

  const flush = Effect.suspend(() => (saving === null ? Effect.void : Deferred.await(saving)));

  /** Merges `main` in, saves the branch and fast-forwards `main` to it, until `main` holds still. */
  const land = Effect.gen(function* () {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      const { main } = yield* drive.open;
      const before = yield* git.resolve("HEAD");
      if (before === null) return { _tag: "not_landed", reason: "Nothing to save yet." } as const;
      if (main !== null && !(yield* git.isAncestor(main, before))) {
        const merge = yield* git.exec([
          "merge",
          "--no-edit",
          "--allow-unrelated-histories",
          "-m",
          DRIVE_MERGE_MESSAGE,
          "refs/drive/main",
        ]);
        if (merge.code !== 0) {
          const files = git.lines(yield* git.run(["diff", "--name-only", "--diff-filter=U"]));
          if (files.length > 0) {
            conflicted = files;
            return { _tag: "conflict", files } as const;
          }
          yield* git.exec(["merge", "--abort"]);
          return {
            _tag: "not_landed",
            reason: `Merging main failed: ${merge.stderr.trim()}`,
          } as const;
        }
      }
      const head = (yield* git.resolve("HEAD"))!;
      const refused = yield* drive.saveBranch(head);
      if (refused !== null) return { _tag: "not_landed", reason: refused } as const;
      const result = yield* input.client.reconcile({ expectedMain: main, newMain: head });
      if (result._tag === "refused") return { _tag: "not_landed", reason: result.reason } as const;
      yield* drive.adopt(result.state);
      if (result._tag === "ok") return { _tag: "landed", main: result.state.main ?? head } as const;
    }
    return {
      _tag: "not_landed",
      reason: "Main kept moving; the thread's branch is saved.",
    } as const;
  });

  const mergeInProgress = git.resolve("MERGE_HEAD").pipe(Effect.map((oid) => oid !== null));

  /** Conflicted files that still hold conflict markers. */
  const unresolvedFiles = Effect.gen(function* () {
    const unmerged = git.lines(yield* git.run(["diff", "--name-only", "--diff-filter=U"]));
    const unresolved: Array<string> = [];
    for (const file of new Set([...conflicted, ...unmerged])) {
      const text = yield* fs
        .readFileString(path.join(input.cwd, file))
        .pipe(Effect.orElseSucceed(() => ""));
      if (CONFLICT_MARKER.test(text)) unresolved.push(file);
    }
    return unresolved;
  });

  /** Concludes the merge in progress, or answers the files still in conflict. */
  const concludeMerge = Effect.gen(function* () {
    const unresolved = yield* unresolvedFiles;
    if (unresolved.length > 0) return unresolved;
    yield* git.run(["add", "-A"]);
    const stillUnmerged = git.lines(yield* git.run(["ls-files", "-u"]));
    if (stillUnmerged.length > 0) return conflicted.length > 0 ? conflicted : ["(unmerged)"];
    yield* git.run(["commit", "-q", "--no-verify", "--no-edit"]);
    conflicted = [];
    return [];
  });

  const resolveAndLand = Effect.gen(function* () {
    if (yield* mergeInProgress) {
      const files = yield* concludeMerge;
      if (files.length > 0) return { _tag: "conflict", files } as DriveOutcome;
    }
    return yield* land;
  });

  const exclusive = <A, E>(effect: Effect.Effect<A, E>) =>
    flush.pipe(Effect.andThen(lock.withPermits(1)(effect)));

  const checkout = (state: DriveRefs) =>
    Effect.gen(function* () {
      for (const file of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"]) {
        yield* fs.remove(path.join(gitDir, file), { force: true });
      }
      yield* git.setRef(BRANCH, state.thread);
      yield* git.run(["symbolic-ref", "HEAD", BRANCH]);
      const target = state.wip ?? state.thread;
      // Overwrites tracked and untracked files in the way; files the drive lacks stay.
      if (target !== null) yield* git.run(["read-tree", "-u", "--reset", target]);
      // The auto-save shows as uncommitted changes on top of the branch.
      yield* git.run(state.thread === null ? ["read-tree", "--empty"] : ["reset", "-q"]);
    });

  /** Brings a remote-backed drive's `main` to the remote's head. Fails only when the drive has nothing at all. */
  const syncRemote = (remoteToken: string) =>
    Effect.gen(function* () {
      // Through the cloud, which adds the credential; the machine only holds the turn's token.
      const fetched = yield* git.fetchHead(input.client.remoteUrl, REMOTE_REF, remoteToken);
      if (fetched._tag === "failed") {
        if (drive.known().main === null) {
          return yield* new RunnerGitError({
            message: `Fetching ${remote?.repository ?? "the repository"} failed: ${fetched.reason}`,
          });
        }
        yield* Effect.logWarning("fetching the remote failed; working from the drive's copy", {
          reason: fetched.reason,
        });
        return;
      }
      const mirrored = yield* drive.mirrorMain(fetched.head).pipe(Effect.result);
      if (mirrored._tag === "Success" && mirrored.success === null) return;
      const reason =
        mirrored._tag === "Success" ? mirrored.success : Cause.pretty(Cause.fail(mirrored.failure));
      // GitHub may still be catching up on a merge; the drive's copy is the next best start.
      if (drive.known().main === null) {
        return yield* new RunnerGitError({
          message: `Saving ${remote?.repository ?? "the repository"}'s latest version failed: ${reason}`,
        });
      }
      yield* Effect.logWarning("mirroring the remote failed; working from the drive's copy", {
        reason,
      });
    });

  const prepare = (remoteToken: string | null) =>
    exclusive(
      Effect.gen(function* () {
        const existed = yield* fs.exists(gitDir);
        yield* fs.makeDirectory(input.cwd, { recursive: true });
        if (!existed) yield* git.run(["init", "-q", `--initial-branch=signalbox`]);
        for (const [key, value] of CONFIG) yield* git.run(["config", key, value]);
        const localThread = existed ? yield* git.resolve("refs/drive/thread") : null;
        // A drive backed by a remote brings `main` up to it before opening pins the branch's base.
        // Unknown until read once; a drive with none never gets one.
        if (remote !== null && remoteToken !== null) remote = yield* drive.refresh;
        if (remote !== null && remote !== undefined && remoteToken !== null)
          yield* syncRemote(remoteToken);
        const state = yield* drive.open;
        if (!existed || localThread !== state.thread) {
          conflicted = [];
          // The branch may still have files where a shortcut is mounted read-only.
          yield* shortcuts.release;
          yield* checkout(state);
        }
        turnStart = yield* git.resolve("HEAD");
        const mounts = yield* shortcuts.mount(remoteToken);
        return {
          instructions: yield* instructions.compose(mounts.mounted),
          notices: mounts.notices,
        } satisfies PreparedDrive;
      }),
    );

  const finishTurn: RunnerDrive["finishTurn"] = ({ message }) =>
    exclusive(
      Effect.gen(function* () {
        let unresolved: ReadonlyArray<string> = [];
        if (yield* mergeInProgress) {
          unresolved = yield* concludeMerge;
        } else if ((yield* git.run(["status", "--porcelain", "--untracked-files=all"])).trim()) {
          yield* git.run(["add", "-A"]);
          yield* git.run(["commit", "-q", "--no-verify", "-m", commitTitle(message)]);
        }
        const head = yield* git.resolve("HEAD");
        const checkpoint =
          head === null
            ? null
            : {
                start: turnStart,
                commit: head,
                files: yield* git.changedFiles(turnStart ?? EMPTY_TREE, head),
              };
        if (head === null) {
          return { checkpoint, outcome: { _tag: "not_landed", reason: "Nothing to save yet." } };
        }
        if (remote !== null && remote !== undefined) {
          const refused = yield* drive.saveBranch(head);
          return {
            checkpoint,
            outcome:
              refused === null
                ? ({ _tag: "saved", head } as const)
                : ({ _tag: "not_landed", reason: refused } as const),
          };
        }
        const outcome: DriveOutcome =
          unresolved.length > 0 ? { _tag: "conflict", files: unresolved } : yield* land;
        return { checkpoint, outcome };
      }),
    );

  const abandonMerge = exclusive(
    Effect.gen(function* () {
      if (yield* mergeInProgress) yield* git.run(["merge", "--abort"]);
      conflicted = [];
      const head = yield* git.resolve("HEAD");
      const refused = head === null ? null : yield* drive.saveBranch(head);
      return {
        _tag: "not_landed",
        reason: refused ?? "The merge with main was abandoned; the thread's branch is saved.",
      } as DriveOutcome;
    }),
  );

  return {
    prepare,
    autosave,
    flush,
    finishTurn,
    continueAfterResolution: exclusive(resolveAndLand),
    abandonMerge,
  } satisfies RunnerDrive;
});
