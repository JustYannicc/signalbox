import {
  type CommitAuthor,
  type CheckpointViews,
  type DriveCheckpointRecord,
  type FolderInstructions,
  DRIVE_COMMIT_AUTHOR,
  DRIVE_MERGE_MESSAGE,
  Oid,
  CheckpointShortcutView,
  type DriveFileChange,
  type DriveRemote,
  type SkippedFolder,
} from "@signalbox/runner-protocol/DriveProtocol";
import type { PullOperation, PullResult } from "@signalbox/runner-protocol/PullProtocol";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import {
  type DriveClient,
  type DriveClientError,
  DriveRefusedError,
  DriveTooLargeError,
} from "./RunnerDriveClient.ts";
import { CHECKPOINT_NOTES_REF, type DriveRefs, makeDriveMirror } from "./RunnerDriveMirror.ts";
import { EMPTY_TREE, makeRunnerGit, remoteCredentialFile, RunnerGitError } from "./RunnerGit.ts";
import { applyPull } from "./RunnerPull.ts";
import { CACHES_LINE, makeExcludes } from "./RunnerExcludes.ts";
import { makeRunnerInstructions, type RunnerInstructionsError } from "./RunnerInstructions.ts";
import type { DependencyTree, DependencyTreesError } from "./RunnerDependencies.ts";
import { makeMachineState, type OutsideFolder } from "./RunnerMachineState.ts";
import { mergedPullRequestOf } from "./mergedPullRequest.ts";
import { makeRunnerShortcuts, type MountedShortcut } from "./RunnerShortcuts.ts";
import { commitSummary, parseNameStatus } from "./commitSummary.ts";
import type { SecretMask } from "./secretMask.ts";

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
 * A remote-backed drive without a mode mirrors the remote's default branch:
 * `prepare` fetches its full history through the cloud and advances the
 * drive's `main` to it. Turns save their branch for the user to publish, and
 * a merged pull request can bring the remote's latest default branch into
 * the thread (#495).
 *
 * A drive with `mode: "source"` keeps its own `main` while using the remote
 * for history and promised files. Its threads never take in later source
 * commits automatically. They land their own work on the drive; `saveBranch`
 * remains available for an explicit publish through `BranchProtocol.ts`.
 *
 * `prepare` also mounts the drive's shortcuts (`RunnerShortcuts.ts`) and
 * writes the instructions they bring (`RunnerInstructions.ts`), answering
 * that bundle's version so the harness session can follow it.
 *
 * Every save also keeps the thread's machine state (`RunnerMachineState.ts`,
 * #490): what git leaves out of the branch, such as `.env` and `notes/`, and
 * the thread's home. A new machine gets it back before its first turn.
 */

export interface DriveCheckpoint {
  /** The branch when the turn started; null when it had no commit yet. */
  readonly start: string | null;
  readonly commit: string;
  readonly files: ReadonlyArray<DriveFileChange>;
  /** What the machine state leaves out, and how each comes back; absent when none is kept. */
  readonly skipped?: ReadonlyArray<SkippedFolder>;
}

export type DriveOutcome =
  | { readonly _tag: "landed"; readonly main: string }
  /** The thread branch was saved without merging it into main. */
  | { readonly _tag: "saved"; readonly head: string }
  | { readonly _tag: "conflict"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "not_landed"; readonly reason: string }
  /** Nothing was saved, and why: the next turn saves it. */
  | { readonly _tag: "held"; readonly reason: string }
  /** The thread's branch has no commit yet: nothing to save or land. */
  | { readonly _tag: "nothing_saved" };

export type RunnerDriveError =
  | RunnerGitError
  | DriveClientError
  | DriveTooLargeError
  | DriveRefusedError
  | PlatformError.PlatformError;

export type SavedBranch =
  | {
      readonly _tag: "saved";
      readonly head: string;
      /** The remote branch's head the branch has taken in, which publishing may replace. */
      readonly lease: string | null;
    }
  | { readonly _tag: "not_saved"; readonly reason: string };

/** A merged pull request's main that conflicts with the thread's branch, not taken in yet. */
export interface MainConflict {
  readonly pullRequest: number;
  /** The remote's default branch. */
  readonly branch: string;
  readonly files: ReadonlyArray<string>;
}

/** What a turn start left in the working directory. */
export interface PreparedDrive {
  /** The instructions the shortcuts bring; changes when they do (see `RunnerInstructions.ts`). */
  readonly instructions: string;
  /** What the thread should hear about its shortcuts, and about taking in a merged pull request's main. */
  readonly notices: ReadonlyArray<string>;
  /** For the agent to take in (`takeInMain`) and resolve before the turn. */
  readonly mainConflict?: MainConflict;
}

export interface RunnerDrive {
  /**
   * At each turn start: opens the drive and checks the thread's branch out,
   * first bringing a remote-backed drive's `main` up to the remote with the
   * turn's `remoteToken`, then mounts its shortcuts. Everything committed in
   * the checkout until the next turn start is by `author`, `DRIVE_COMMIT_AUTHOR`
   * when not given. `folders` is the `AGENTS.md` of the thread's chain, top
   * level first. `pullRequests` are the thread's links: once its own merged,
   * the remote's default branch is merged into the thread's branch unless this
   * is a pinned continuation. Fails when the instructions are too big to load.
   */
  readonly prepare: (
    remoteToken: string | null,
    author?: CommitAuthor,
    folders?: ReadonlyArray<FolderInstructions>,
    pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
  ) => Effect.Effect<PreparedDrive, RunnerDriveError | RunnerInstructionsError>;
  /** Starts an auto-save, or queues one behind the running one. Never fails. */
  readonly autosave: Effect.Effect<void>;
  /** Waits for running and queued auto-saves. */
  readonly flush: Effect.Effect<void>;
  /** Saves now, after any running auto-save, and fails as the save does. */
  readonly saveNow: Effect.Effect<void, RunnerDriveError>;
  /**
   * Whether anything the drive keeps changed since its last successful save
   * (#493). False before the drive was first prepared here.
   */
  readonly changed: Effect.Effect<boolean, RunnerDriveError>;
  /**
   * After the turn start's dependency installs: puts back files the thread
   * edited inside dependency trees, where the rebuild landed on the key they
   * were edited at. Only after `prepare` restored the thread on a new machine.
   */
  readonly restoreDependencyEdits: Effect.Effect<void>;
  /** The commits mounted for shortcuts and the context view pinned for this turn. */
  readonly checkpointViews: (context: CheckpointViews["context"]) => CheckpointViews;
  /** Adds a durable Git note and registers its uploaded ref before the checkpoint event is emitted. */
  readonly recordCheckpoint: (
    record: Omit<DriveCheckpointRecord, "notes"> & { readonly threadId: string },
  ) => Effect.Effect<void, RunnerDriveError>;
  /** Saves the current worktree as an auto-save revision without landing the branch. */
  readonly captureCheckpoint: Effect.Effect<DriveCheckpoint | null, RunnerDriveError>;
  /**
   * Commits the turn's files with a message describing the change (never the
   * turn's prompt, which pushing would publish), then lands or saves the branch.
   * A pinned continuation saves its selected branch without taking in main.
   */
  readonly finishTurn: () => Effect.Effect<
    { readonly checkpoint: DriveCheckpoint | null; readonly outcome: DriveOutcome },
    RunnerDriveError
  >;
  readonly continueAfterResolution: Effect.Effect<DriveOutcome, RunnerDriveError>;
  /**
   * Merges in the main `prepare` reported as `mainConflict`: `saved` once it
   * is in, or the conflict for the agent to resolve.
   */
  readonly takeInMain: Effect.Effect<DriveOutcome, RunnerDriveError>;
  readonly abandonMerge: Effect.Effect<DriveOutcome, RunnerDriveError>;
  /**
   * Commits the worktree's changes with `message`, or a description of the
   * change when none is given, and saves the thread's branch now, as
   * `finishTurn` would. Only a drive backed by a remote.
   */
  readonly saveBranch: (message?: string) => Effect.Effect<SavedBranch, RunnerDriveError>;
  /**
   * Records that GitHub's copy of the thread's branch is now `head`, as a
   * push does, so the next push's lease is that head rather than the last
   * fetched one.
   */
  readonly published: (head: string) => Effect.Effect<void, RunnerDriveError>;
  /** Applies or returns the durable result for one selected remote pull. */
  readonly pull: (
    operation: PullOperation,
    remoteToken: string | null,
    blockedReason?: string,
  ) => Effect.Effect<PullResult, RunnerDriveError>;
}

const CheckpointNoteJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    turnId: Schema.String,
    runId: Schema.String,
    commit: Oid,
    start: Schema.NullOr(Oid),
    views: Schema.Struct({
      shortcuts: Schema.Array(CheckpointShortcutView),
      context: Schema.NullOr(
        Schema.Array(Schema.Struct({ driveId: Schema.String, commit: Schema.NullOr(Oid) })),
      ),
    }),
  }),
);
const encodeCheckpointNote = Schema.encodeSync(CheckpointNoteJson);

const BRANCH = "refs/heads/signalbox";
/** The remote's head as last fetched. */
const REBASE_DIRS = ["rebase-merge", "rebase-apply"];
const configFor = (author: CommitAuthor) =>
  [
    ["user.name", author.name],
    ["user.email", author.email],
    ["gc.auto", "0"],
    ["core.quotepath", "false"],
  ] as const;
const RECONCILE_ATTEMPTS = 5;
const CONFLICT_MARKER = /^(<<<<<<<|>>>>>>>) /m;

export const makeRunnerDrive = Effect.fn("makeRunnerDrive")(function* (input: {
  /** The thread's working directory. */
  readonly cwd: string;
  readonly client: DriveClient;
  /** The thread's own branch on a remote-backed drive's remote, which `git pull` follows. */
  readonly branch?: string;
  /** What the thread's machine state holds beyond the checkout; none kept when absent. */
  readonly machine?: {
    readonly outside: ReadonlyArray<OutsideFolder>;
    readonly trees: Effect.Effect<ReadonlyArray<DependencyTree>, DependencyTreesError>;
  };
  /** Hides the folder's secrets in every commit message written here (#602). */
  readonly secretMask?: SecretMask;
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
  /** The main a turn start reported conflicting, and its merge message, until taken in or dropped. */
  let syncing: { readonly main: string; readonly message: string } | null = null;
  /** The remote the drive is backed by, once read; a drive's remote never changes. */
  let remote: DriveRemote | null | undefined = undefined;
  /** Whether a turn start opened the drive here: only then is there anything to save. */
  let prepared = false;
  /** A restored/forked thread stays on its selected input until it explicitly updates to latest. */
  let pinnedContinuation = false;
  /** Where the last turn mounted the drive's shortcuts. */
  let mounted: ReadonlySet<string> = new Set();
  let mountedShortcuts: ReadonlyArray<MountedShortcut> = [];
  const machineState =
    input.machine === undefined
      ? null
      : yield* makeMachineState({
          cwd: input.cwd,
          gitDir,
          git,
          outside: input.machine.outside,
          trees: input.machine.trees,
          shortcuts: () => mounted,
        });

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

  const mask = (text: string) =>
    input.secretMask === undefined ? text : input.secretMask.text(text);

  /**
   * Stages everything and, when anything changed, commits it with `message`,
   * or a description of the change when none is given (`commitSummary.ts`).
   * Secrets are masked either way.
   */
  const commitAll = (message?: string) =>
    Effect.gen(function* () {
      yield* git.run(["add", "-A"]);
      const staged = parseNameStatus(
        yield* git.run(["diff", "--cached", "--name-status", "-M", "-z"]),
      );
      if (staged.length === 0) return;
      const text =
        message !== undefined && message.trim() !== ""
          ? mask(message.trim())
          : commitSummary(
              staged.map(({ from, ...change }) => ({
                ...change,
                path: mask(change.path),
                ...(from === undefined ? {} : { from: mask(from) }),
              })),
            );
      yield* git.run(["commit", "-q", "--no-verify", "-m", text]);
    });

  const treeOf = (commit: string | null) =>
    commit === null
      ? Effect.succeed(EMPTY_TREE)
      : git.run(["rev-parse", `${commit}^{tree}`]).pipe(Effect.map((out) => out.trim()));

  /** Whether the agent's rebase stopped partway, say at a conflict. */
  const rebasing = Effect.map(
    Effect.forEach(REBASE_DIRS, (dir) => fs.exists(path.join(gitDir, dir))),
    (found) => found.some(Boolean),
  );

  const saveTracked = Effect.gen(function* () {
    // Mid-merge or mid-rebase the worktree holds conflict markers; the last save before stands.
    if ((yield* git.resolve("MERGE_HEAD")) !== null || (yield* rebasing)) return;
    const head = yield* git.resolve("HEAD");
    const tree = yield* snapshotTree(head);
    if (tree === (yield* treeOf(drive.known().wip ?? head))) return;
    const parent = head === null ? [] : ["-p", head];
    const commit = (yield* git.run(["commit-tree", tree, ...parent, "-m", "Auto-save"])).trim();
    const refused = yield* drive.saveWip(commit);
    if (refused !== null) yield* Effect.logWarning("the drive refused an auto-save", { refused });
  });

  /**
   * Saves the machine state beside the latest auto-save, when it changed, and
   * answers what it left out; null when none is kept. A cloud that keeps none
   * gets none: its packs would be handed to every thread. `scanEdits`: look
   * for edits inside dependency trees again (`RunnerMachineState.capture`).
   */
  const saveMachine = (scanEdits: boolean) =>
    Effect.gen(function* () {
      if (machineState === null || !drive.keepsMachine()) return null;
      const known = drive.known();
      const captured = yield* machineState.capture(yield* treeOf(known.wip ?? known.thread), {
        scanEdits,
      });
      const tree = captured.tree ?? EMPTY_TREE;
      if (tree === (yield* treeOf(known.machine))) return captured.skipped;
      const commit = (yield* git.run(["commit-tree", tree, "-m", "Machine state"])).trim();
      const refused = yield* drive.saveMachine(commit);
      if (refused !== null) {
        yield* Effect.logWarning("the drive refused the machine state", { refused });
      }
      return captured.skipped;
    });

  /**
   * Written as the last successful save started, by the filesystem's own
   * clock: anything newer is unsaved. A save writes `saving` first and moves
   * it there once it succeeded, so a failed one leaves its changes unsaved.
   */
  const savedStamp = path.join(gitDir, "signalbox-saved");
  const savingStamp = path.join(gitDir, "signalbox-saving");

  const saveWip = Effect.gen(function* () {
    yield* fs.writeFileString(savingStamp, "");
    yield* saveTracked;
    yield* saveMachine(false);
    yield* fs.rename(savingStamp, savedStamp);
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

  /** Commits everything in the worktree, when anything changed. */
  /** Merges `ref` in, leaving a conflict in the worktree; any other failure is undone. */
  const mergeIn = (ref: string, message: string, options: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const merge = yield* git.exec(["merge", "--no-edit", ...options, "-m", message, ref]);
      if (merge.code === 0) return { _tag: "merged" } as const;
      const files = git.lines(yield* git.run(["diff", "--name-only", "--diff-filter=U"]));
      if (files.length > 0) {
        conflicted = files;
        return { _tag: "conflict", files } as const;
      }
      yield* git.exec(["merge", "--abort"]);
      return { _tag: "failed", reason: merge.stderr.trim() || "git merge failed" } as const;
    });

  /** Merges `main` in, saves the branch and fast-forwards `main` to it, until `main` holds still. */
  const land = Effect.gen(function* () {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      const { main } = yield* drive.open;
      const before = yield* git.resolve("HEAD");
      if (before === null) return { _tag: "nothing_saved" } as const;
      if (main !== null && !(yield* git.isAncestor(main, before))) {
        const merged = yield* mergeIn("refs/drive/main", DRIVE_MERGE_MESSAGE, [
          "--allow-unrelated-histories",
        ]);
        if (merged._tag === "conflict") return merged;
        if (merged._tag === "failed") {
          return { _tag: "not_landed", reason: `Merging main failed: ${merged.reason}` } as const;
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

  /**
   * A remote-backed drive's merge is a turn start's (#495), concluded: the
   * branch is saved, and the turn's checkpoint starts after the merge.
   */
  const saveSynced = Effect.gen(function* () {
    const head = yield* git.resolve("HEAD");
    const main = syncing?.main ?? null;
    syncing = null;
    if (head === null) return { _tag: "nothing_saved" } as const;
    turnStart = head;
    if (main !== null && !(yield* git.isAncestor(main, head))) {
      return { _tag: "not_landed", reason: "the agent dropped the merge" } as const;
    }
    // The turn's end saves it again if the drive refuses it now.
    const refused = yield* drive.saveBranch(head);
    if (refused !== null) {
      yield* Effect.logWarning("the drive refused the merged branch", { refused });
    }
    return { _tag: "saved", head } as const;
  });

  const resolveAndLand = Effect.gen(function* () {
    if (yield* mergeInProgress) {
      const files = yield* concludeMerge;
      if (files.length > 0) return { _tag: "conflict", files } as DriveOutcome;
    }
    if (pinnedContinuation) {
      const head = yield* git.resolve("HEAD");
      if (head === null) return { _tag: "nothing_saved" } as const;
      const refused = yield* drive.saveBranch(head);
      return refused === null
        ? ({ _tag: "saved", head } as const)
        : ({ _tag: "not_landed", reason: refused } as const);
    }
    // A source remote supplies history and files; the drive still owns main.
    return syncing === null && (remote === null || remote === undefined || remote.mode === "source")
      ? yield* land
      : yield* saveSynced;
  });

  const takeInMain = Effect.gen(function* () {
    if (syncing === null) return { _tag: "not_landed", reason: "Nothing to take in." } as const;
    const merged = yield* mergeIn(syncing.main, syncing.message, ["--no-verify"]);
    if (merged._tag === "merged") return yield* saveSynced;
    if (merged._tag === "conflict") return merged;
    syncing = null;
    return { _tag: "not_landed", reason: merged.reason } as const;
  });

  /** Keeps dependency trees off the branch, whatever the repository's own ignore files say. */
  const excludeCaches = makeExcludes(fs, path, gitDir).appendLines([CACHES_LINE]);

  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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

  /**
   * Makes the drive's remote `origin`, fetches its whole history blobless
   * (commits and folders; files on demand, #394) and answers its default
   * branch's head. The agent's own `git fetch`, `pull` and `rebase` reach it
   * the same way while the turn runs.
   */
  const fetchHistory = (from: DriveRemote) =>
    Effect.gen(function* () {
      for (const [key, value] of [
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ...(input.branch === undefined
          ? []
          : [
              ["branch.signalbox.remote", "origin"],
              ["branch.signalbox.merge", `refs/heads/${input.branch}`],
            ]),
      ] as const) {
        yield* git.run(["config", "--replace-all", key, value]);
      }
      // Shallow only from before history came along, or a failed fetch; deepening sends folders once.
      const shallow = yield* fs.exists(path.join(gitDir, "shallow"));
      const fetched = yield* git.exec([
        "fetch",
        "--filter=blob:none",
        "--no-tags",
        // Branches deleted on GitHub go here too, so nothing counts as on GitHub that isn't.
        "--prune",
        "-q",
        ...(shallow ? ["--unshallow"] : []),
        "origin",
      ]);
      if (fetched.code !== 0) {
        return {
          _tag: "failed",
          reason: fetched.stderr.trim() || `git fetch exited ${fetched.code}`,
        } as const;
      }
      const head = yield* git.resolve(`refs/remotes/origin/${from.defaultBranch}`);
      return head === null
        ? ({ _tag: "failed", reason: "The remote has no default branch yet." } as const)
        : ({ _tag: "fetched", head } as const);
    });

  /** Brings a mirror drive's `main` to the remote's head. Fails only when the drive has nothing at all. */
  const syncRemote = (fetched: Effect.Success<ReturnType<typeof fetchHistory>>) =>
    Effect.gen(function* () {
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
      if (mirrored._tag === "Failure" && mirrored.failure._tag === "DriveTooLargeError") {
        // Retrying won't shrink it: say what's too big.
        return yield* new DriveTooLargeError({
          message: `Signalbox can't save ${remote?.repository ?? "this repository"} to its drive: ${mirrored.failure.message}`,
        });
      }
      // The error's own words: this becomes the turn's failure message, so no stack.
      const reason = mirrored._tag === "Success" ? mirrored.success : mirrored.failure.message;
      // GitHub may still be catching up on a merge; the drive's copy is the next best start.
      if (drive.known().main === null) {
        return yield* new RunnerGitError({
          message: `Saving ${remote?.repository ?? "the repository"}'s latest version failed: ${reason}`,
        });
      }
      yield* Effect.logWarning("mirroring the remote failed; working from the drive's copy", {
        reason,
        ...(mirrored._tag === "Failure" ? { error: mirrored.failure } : {}),
      });
    });

  /**
   * Merges the remote's default branch at `main`, as just fetched, into the
   * thread's branch after the thread's pull request `number` merged there
   * (#495). Uncommitted work is committed first, so the merge never touches
   * it. A conflict is undone and kept in `syncing`: only the agent can resolve
   * it, once its session runs. A merge or rebase the agent left in progress
   * stays as it is.
   */
  const syncMain = (number: number, from: DriveRemote, main: string) =>
    Effect.gen(function* () {
      const head = yield* git.resolve("HEAD");
      if (head === null || (yield* git.isAncestor(main, head))) return null;
      if ((yield* mergeInProgress) || (yield* rebasing)) return null;
      yield* commitAll();
      const message = `Merge ${from.defaultBranch} after #${number} merged`;
      const merged = yield* mergeIn(main, message, ["--no-verify"]);
      if (merged._tag === "merged") yield* saveSynced;
      if (merged._tag === "conflict") {
        yield* git.run(["merge", "--abort"]);
        conflicted = [];
        syncing = { main, message };
      }
      return merged;
    });

  const prepare: RunnerDrive["prepare"] = (
    remoteToken,
    author = DRIVE_COMMIT_AUTHOR,
    folders = [],
    pullRequests = [],
  ) =>
    exclusive(
      Effect.gen(function* () {
        const existed = yield* fs.exists(gitDir);
        yield* fs.makeDirectory(input.cwd, { recursive: true });
        if (!existed) yield* git.run(["init", "-q", `--initial-branch=signalbox`]);
        for (const [key, value] of configFor(author)) yield* git.run(["config", key, value]);
        yield* git.run(["config", "core.notesRef", CHECKPOINT_NOTES_REF]);
        yield* git.run(["config", "notes.displayRef", CHECKPOINT_NOTES_REF]);
        yield* excludeCaches;
        const localThread = existed ? yield* git.resolve("refs/drive/thread") : null;
        // A merge a turn start reported belongs to that turn alone.
        syncing = null;
        /** The remote's default branch, when this turn start fetched it: only then is it current. */
        let fetchedMain: string | null = null;
        // Read once on the first turn and again for remote-backed drives. Only mirror mode
        // advances `main`; a source still needs the history for promised files and git operations.
        if (remote !== null && remoteToken !== null) {
          const current = yield* input.client.state;
          remote = current.remote;
          let fetched: Effect.Success<ReturnType<typeof fetchHistory>> | null = null;
          if (remote !== null) {
            // The drive keeps the remote's files on the remote; git fetches them as it needs them.
            const credentials = remoteCredentialFile(input.cwd);
            yield* fs.writeFileString(
              credentials,
              `username=signalbox\npassword=${remoteToken}\n`,
              { mode: 0o600 },
            );
            yield* git.usePromisor(input.client.remoteUrl, credentials);
            // History before the drive's packs: a remote commit they hold one deep would
            // otherwise be marked shallow here, and cut the fetch short.
            fetched = yield* fetchHistory(remote);
          }
          yield* drive.adopt(current);
          if (fetched !== null && remote?.mode !== "source") yield* syncRemote(fetched);
          if (fetched?._tag === "fetched") fetchedMain = fetched.head;
        }
        const state = yield* drive.open;
        pinnedContinuation = state.pinnedViews !== null;
        const revisionFile = path.join(gitDir, "signalbox-revision");
        const localRevision = yield* fs.readFileString(revisionFile).pipe(
          Effect.map((value) => value.trim() || null),
          Effect.orElseSucceed(() => null),
        );
        const revisionChanged =
          state.revision !== undefined && (state.revision ?? "") !== (localRevision ?? "");
        const notices: Array<string> = [];
        if (!existed || localThread !== state.thread || revisionChanged) {
          conflicted = [];
          // The branch may still have files where a shortcut is mounted read-only.
          yield* shortcuts.release;
          if (revisionChanged) yield* git.run(["clean", "-ffdq"]);
          yield* checkout(state).pipe(
            Effect.catchTags({
              RunnerGitError: (error) =>
                remote === null || remote === undefined
                  ? Effect.fail(error)
                  : // A remote-backed drive keeps the remote's files on the remote (#406).
                    Effect.fail(
                      new RunnerGitError({
                        message: `Checking this thread out needs files ${remote.repository} keeps on GitHub, and GitHub can't be reached through Signalbox right now. ${error.message}`,
                      }),
                    ),
            }),
          );
          yield* fs.writeFileString(revisionFile, state.revision ?? "");
        }
        // A new machine: the last one's machine state comes back on top of the checkout.
        if (!existed && machineState !== null && state.machine !== null) {
          yield* machineState.restore(state.machine, state.wip ?? state.thread).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("restoring the machine state failed", Cause.pretty(cause)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    notices.push(
                      "Some of this thread's files outside git (ignored files, its home folder) couldn't be brought back to this machine.",
                    );
                  }),
                ),
              ),
            ),
          );
        }
        let mainConflict: MainConflict | undefined;
        const merged =
          fetchedMain === null ||
          remote === null ||
          remote === undefined ||
          remote.mode === "source" ||
          input.branch === undefined
            ? null
            : mergedPullRequestOf(pullRequests, {
                branch: input.branch,
                repository: remote.repository,
              });
        if (
          merged !== null &&
          fetchedMain !== null &&
          remote !== null &&
          remote !== undefined &&
          remote.mode !== "source" &&
          !pinnedContinuation
        ) {
          const main = remote.defaultBranch;
          const outcome = yield* syncMain(merged, remote, fetchedMain);
          if (outcome?._tag === "merged") {
            notices.push(
              `Pull request #${merged} merged, so this thread took in the latest ${main} first.`,
            );
          } else if (outcome?._tag === "failed") {
            notices.push(
              `Pull request #${merged} merged, but taking in the latest ${main} failed, so this turn works on the branch as it was: ${outcome.reason}`,
            );
          } else if (outcome?._tag === "conflict") {
            mainConflict = { pullRequest: merged, branch: main, files: outcome.files };
          }
        }
        turnStart = yield* git.resolve("HEAD");
        prepared = true;
        const mounts = yield* shortcuts.mount(remoteToken, state.pinnedViews !== null);
        mounted = new Set(mounts.mounted.map((mount) => mount.path));
        mountedShortcuts = mounts.mounted;
        return {
          instructions: yield* instructions.compose(mounts.mounted, folders),
          notices: [...notices, ...mounts.notices],
          ...(mainConflict === undefined ? {} : { mainConflict }),
        } satisfies PreparedDrive;
      }),
    );

  /** Saves the turn's machine state beside its branch, and lists what it left out on the checkpoint. */
  const withMachineState = <E>(
    finished: Effect.Effect<
      { readonly checkpoint: DriveCheckpoint | null; readonly outcome: DriveOutcome },
      E
    >,
  ) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(savingStamp, "");
      const result = yield* finished;
      // The turn's files are saved whatever happens here.
      const skipped = yield* saveMachine(true).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("saving the machine state failed", Cause.pretty(cause)).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      // Everything as of the turn's end is saved: the next change is what's new.
      if (skipped !== undefined && result.outcome._tag !== "held") {
        yield* fs.rename(savingStamp, savedStamp);
      }
      return result.checkpoint === null || skipped === null || skipped === undefined
        ? result
        : { ...result, checkpoint: { ...result.checkpoint, skipped } };
    });

  const finishTurn: RunnerDrive["finishTurn"] = () =>
    exclusive(
      withMachineState(
        Effect.gen(function* () {
          // Committing now would commit onto the rebase's detached HEAD; the branch stays as last saved.
          if (yield* rebasing) {
            return {
              checkpoint: null,
              outcome: {
                _tag: "held",
                reason:
                  "This turn's work isn't saved yet: a rebase is still in progress. Finish or abort it, and the next turn saves it.",
              },
            } as const;
          }
          let unresolved: ReadonlyArray<string> = [];
          if (yield* mergeInProgress) {
            unresolved = yield* concludeMerge;
          } else {
            yield* commitAll();
          }
          let head = yield* git.resolve("HEAD");
          if (head === null) {
            // The first completed turn needs a real, restorable revision even when it wrote no files.
            head = (yield* git.run([
              "commit-tree",
              EMPTY_TREE,
              "-m",
              "Initialize the drive",
            ])).trim();
            yield* git.setRef(BRANCH, head);
          }
          const checkpoint = {
            start: turnStart,
            commit: head,
            files: yield* git.changedFiles(turnStart ?? EMPTY_TREE, head),
          };
          if (
            (remote !== null && remote !== undefined && remote.mode !== "source") ||
            pinnedContinuation
          ) {
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
      ),
    );

  const captureCheckpoint: RunnerDrive["captureCheckpoint"] = Effect.suspend(() =>
    prepared
      ? exclusive(
          Effect.gen(function* () {
            yield* saveWip;
            let commit = drive.known().wip ?? drive.known().thread;
            if (commit === null) {
              commit = (yield* git.run([
                "commit-tree",
                EMPTY_TREE,
                "-m",
                "Initialize the drive",
              ])).trim();
              const refused = yield* drive.saveWip(commit);
              if (refused !== null) return yield* new DriveRefusedError({ message: refused });
              commit = drive.known().wip ?? commit;
            }
            return {
              start: turnStart,
              commit,
              files: yield* git.changedFiles(turnStart ?? EMPTY_TREE, commit),
            };
          }),
        )
      : Effect.succeed(null),
  );

  const abandonMerge = exclusive(
    Effect.gen(function* () {
      if (yield* mergeInProgress) yield* git.run(["merge", "--abort"]);
      conflicted = [];
      syncing = null;
      const head = yield* git.resolve("HEAD");
      const refused = head === null ? null : yield* drive.saveBranch(head);
      return {
        _tag: "not_landed",
        reason: refused ?? "The merge with main was abandoned; the thread's branch is saved.",
      } as DriveOutcome;
    }),
  );

  /**
   * The thread's remote branch head as last fetched, once the branch has taken
   * it in: it is on the branch, or the branch was there before a rebase
   * rewrote it. Publishing may replace that head and nothing newer.
   */
  const lease = Effect.gen(function* () {
    if (input.branch === undefined) return null;
    const tip = yield* git.resolve(`refs/remotes/origin/${input.branch}`);
    if (tip === null) return null;
    const visited = git.lines((yield* git.exec(["rev-list", "--walk-reflogs", BRANCH])).stdout);
    const unseen = yield* git.run(["rev-list", "-n1", "--stdin"], {
      stdin: [tip, "^HEAD", ...visited.map((oid) => `^${oid}`), ""].join("\n"),
    });
    return unseen.trim() === "" ? tip : null;
  });

  const saveBranch: RunnerDrive["saveBranch"] = (message) =>
    exclusive(
      Effect.gen(function* () {
        if (remote === undefined) remote = yield* drive.refresh;
        if (remote === null) {
          return {
            _tag: "not_saved",
            reason: "This project isn't backed by a GitHub repository.",
          } as const;
        }
        if (yield* mergeInProgress) {
          return {
            _tag: "not_saved",
            reason: "A merge is in progress here; resolve it before publishing.",
          } as const;
        }
        if (yield* rebasing) {
          return {
            _tag: "not_saved",
            reason: "A rebase is in progress here; finish or abort it before publishing.",
          } as const;
        }
        yield* commitAll(message);
        const head = yield* git.resolve("HEAD");
        if (head === null) return { _tag: "not_saved", reason: "Nothing to save yet." } as const;
        const refused = yield* drive.saveBranch(head);
        return refused === null
          ? ({ _tag: "saved", head, lease: yield* lease } as const)
          : ({ _tag: "not_saved", reason: refused } as const);
      }),
    );

  const initializePullRepository = () =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(input.cwd, { recursive: true });
      const existed = yield* fs.exists(gitDir);
      if (!existed) yield* git.run(["init", "-q", "--initial-branch=signalbox"]);
      for (const [key, value] of configFor(DRIVE_COMMIT_AUTHOR)) {
        yield* git.run(["config", key, value]);
      }
      yield* git.run(["config", "core.notesRef", CHECKPOINT_NOTES_REF]);
      yield* git.run(["config", "notes.displayRef", CHECKPOINT_NOTES_REF]);
      yield* excludeCaches;
      return existed;
    });

  const restorePullCheckout = (existed: boolean) =>
    Effect.gen(function* () {
      if (existed) return;
      const known = drive.known();
      yield* checkout(known);
      if (machineState !== null && known.machine !== null) {
        yield* machineState.restore(known.machine, known.wip ?? known.thread);
      }
    });

  const markPulledTarget = (operation: PullOperation, result: PullResult) =>
    Effect.gen(function* () {
      if (
        result.outcome === "refused" ||
        input.branch === undefined ||
        operation.branch !== input.branch
      ) {
        return result;
      }
      // A successful receipt may be replayed on a replacement machine before it
      // has a Git repository. Restore the drive refs before recording the lease.
      const existed = yield* initializePullRepository();
      yield* drive.open;
      yield* restorePullCheckout(existed);
      const trackingRef = `refs/remotes/origin/${operation.branch}`;
      if ((yield* lease) === null) {
        // Only the commit the person selected is incorporated. The branch may
        // have moved beyond it while the fetch was in flight. Keep a newer tip
        // only when the ordinary lease check proves it is already in this branch.
        yield* git.setRef(trackingRef, operation.target);
      }
      return result;
    });

  const pull: RunnerDrive["pull"] = (operation, remoteToken, blockedReason) =>
    Effect.gen(function* () {
      const run = exclusive(
        Effect.gen(function* () {
          // A duplicate can have completed while this operation waited for an auto-save or lock.
          const replay = yield* drive.pullReceipt(operation.id);
          if (replay !== null) return yield* markPulledTarget(operation, replay);

          const unchanged = (reason: string) =>
            Effect.gen(function* () {
              const status = (yield* fs.exists(gitDir))
                ? yield* git
                    .run(["status", "--porcelain=v1", "--untracked-files=all", "-z"])
                    .pipe(Effect.orElseSucceed(() => ""))
                : "";
              return {
                id: operation.id,
                target: operation.target,
                head: operation.expectedThread,
                wip: operation.expectedWip,
                outcome: "refused",
                reason,
                hasWorkingTreeChanges: status.length > 0,
              } satisfies PullResult;
            });

          if (blockedReason !== undefined) {
            return yield* drive.savePull(operation, yield* unchanged(blockedReason));
          }

          const existed = yield* initializePullRepository();

          yield* drive.open;
          const known = drive.known();
          if (
            known.thread !== operation.expectedThread ||
            known.wip !== operation.expectedWip ||
            known.revision !== operation.revision
          ) {
            return yield* drive.savePull(
              operation,
              yield* unchanged("The thread's saved files changed after this pull was selected."),
            );
          }
          remote = yield* drive.refresh;
          if (remote === null) {
            return yield* drive.savePull(
              operation,
              yield* unchanged("This drive is not backed by a remote Git repository."),
            );
          }
          if (remoteToken === null) {
            return yield* drive.savePull(
              operation,
              yield* unchanged("Signalbox could not authorize a fetch from this repository."),
            );
          }
          const branchRef = `refs/heads/${operation.branch}`;
          const validBranch = yield* git.exec(["check-ref-format", branchRef]);
          if (validBranch.code !== 0) {
            return yield* drive.savePull(
              operation,
              yield* unchanged("The selected remote branch name is invalid."),
            );
          }
          const inProgress =
            (yield* git.resolve("MERGE_HEAD")) !== null ||
            (yield* Effect.forEach(REBASE_DIRS, (name) => fs.exists(path.join(gitDir, name)))).some(
              Boolean,
            );
          if (inProgress) {
            return yield* drive.savePull(
              operation,
              yield* unchanged("A merge or rebase is already in progress in this thread."),
            );
          }

          const credentialFile = remoteCredentialFile(input.cwd);
          yield* fs.writeFileString(
            credentialFile,
            `username=signalbox\npassword=${remoteToken}\n`,
            { mode: 0o600 },
          );
          yield* git.usePromisor(input.client.remoteUrl, credentialFile);

          yield* restorePullCheckout(existed);

          const source = `refs/signalbox/pull-source/${operation.target}`;
          const shallow = yield* fs.exists(path.join(gitDir, "shallow"));
          const fetched = yield* git.exec([
            "fetch",
            "--filter=blob:none",
            "--no-tags",
            "-q",
            ...(shallow ? ["--unshallow"] : []),
            input.client.remoteUrl,
            `+${branchRef}:${source}`,
          ]);
          if (fetched.code !== 0) {
            return yield* drive.savePull(
              operation,
              yield* unchanged(
                "Signalbox couldn't fetch the selected commit from its remote branch.",
              ),
            );
          }

          const result = yield* applyPull({
            cwd: input.cwd,
            gitDir,
            git,
            operation,
            source,
            saveWip: (head) =>
              Effect.gen(function* () {
                const tree = yield* snapshotTree(head);
                if (tree === (yield* treeOf(head))) return head;
                return (yield* git.run([
                  "commit-tree",
                  tree,
                  "-p",
                  head,
                  "-m",
                  "Auto-save",
                ])).trim();
              }),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          const saved = yield* drive.savePull(operation, result);
          return yield* markPulledTarget(operation, saved);
        }),
      );
      return yield* run;
    });

  const recordCheckpoint: RunnerDrive["recordCheckpoint"] = (record) =>
    exclusive(
      Effect.gen(function* () {
        const note = encodeCheckpointNote({
          threadId: record.threadId,
          turnId: record.turnId,
          runId: record.runId,
          commit: record.commit,
          start: record.start,
          views: {
            shortcuts: record.views.shortcuts,
            context:
              record.views.context?.contexts.flatMap((context) =>
                context.drives.map(({ driveId, commit }) => ({ driveId, commit })),
              ) ?? null,
          },
        });
        const existing = yield* git.exec([
          "notes",
          `--ref=${CHECKPOINT_NOTES_REF}`,
          "show",
          record.commit,
        ]);
        if (existing.code !== 0 || !existing.stdout.split("\n").includes(note)) {
          yield* git.run(
            ["notes", `--ref=${CHECKPOINT_NOTES_REF}`, "append", "-F", "-", record.commit],
            { stdin: `${note}\n` },
          );
        }
        const notes = yield* git.resolve(CHECKPOINT_NOTES_REF);
        if (notes === null) {
          return yield* new RunnerGitError({ message: "git notes didn't create a notes ref." });
        }
        yield* drive.saveNotes(notes);
        const result = yield* input.client.recordCheckpoint({ ...record, notes });
        if (result._tag === "refused") {
          return yield* new DriveRefusedError({ message: result.reason });
        }
        if (result._tag === "conflict") {
          return yield* new DriveRefusedError({
            message: "The drive changed while this checkpoint was being recorded.",
          });
        }
        yield* drive.adopt(result.state);
      }),
    );

  return {
    prepare,
    autosave,
    flush,
    // Nothing to save before a turn start opened the drive here.
    saveNow: Effect.suspend(() => (prepared ? exclusive(saveWip) : Effect.void)),
    changed: Effect.suspend(() =>
      prepared && machineState !== null
        ? machineState.changedSince(savedStamp)
        : Effect.succeed(false),
    ),
    restoreDependencyEdits:
      machineState === null
        ? Effect.void
        : exclusive(machineState.restoreEdits).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "restoring edits inside dependency trees failed",
                Cause.pretty(cause),
              ),
            ),
          ),
    checkpointViews: (context) => ({
      shortcuts: mountedShortcuts.map(({ path, target, commit }) => ({ path, target, commit })),
      context,
    }),
    recordCheckpoint,
    captureCheckpoint,
    finishTurn,
    continueAfterResolution: exclusive(resolveAndLand),
    takeInMain: exclusive(takeInMain),
    abandonMerge,
    saveBranch,
    pull,
    published: (head) =>
      input.branch === undefined
        ? Effect.void
        : git.setRef(`refs/remotes/origin/${input.branch}`, head),
  } satisfies RunnerDrive;
});
