import type { DriveFileChange } from "@signalbox/runner-protocol/DriveProtocol";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import type { DriveClient, DriveClientError } from "./RunnerDriveClient.ts";
import { type DriveRefs, makeDriveMirror } from "./RunnerDriveMirror.ts";
import { EMPTY_TREE, makeRunnerGit, type RunnerGitError } from "./RunnerGit.ts";

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
 */

export interface DriveCheckpoint {
  /** The branch when the turn started; null when it had no commit yet. */
  readonly start: string | null;
  readonly commit: string;
  readonly files: ReadonlyArray<DriveFileChange>;
}

export type DriveOutcome =
  | { readonly _tag: "landed"; readonly main: string }
  | { readonly _tag: "conflict"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "not_landed"; readonly reason: string };

export type RunnerDriveError = RunnerGitError | DriveClientError | PlatformError.PlatformError;

export interface RunnerDrive {
  /** At each turn start: opens the drive and checks the thread's branch out. */
  readonly prepare: Effect.Effect<void, RunnerDriveError>;
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
const CONFIG = [
  ["user.name", "Signalbox"],
  ["user.email", "agent@signalbox.invalid"],
  ["gc.auto", "0"],
  ["core.quotepath", "false"],
] as const;
/**
 * Never saved to a drive, whatever its own ignore files say: dependency trees
 * are the machine's cache (`RunnerDependencies.ts`), rebuilt from lockfiles.
 */
const EXCLUDE = "node_modules/";
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
  const lock = yield* Semaphore.make(1);
  /** HEAD when the turn started: the base of its checkpoint. */
  let turnStart: string | null = null;
  /** Files the last merge left conflicted. */
  let conflicted: ReadonlyArray<string> = [];

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
          "Merge main",
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

  /** Adds `EXCLUDE` to the repository's own excludes, keeping whatever else is there. */
  const excludeCaches = Effect.gen(function* () {
    const file = path.join(gitDir, "info", "exclude");
    const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (current.split("\n").includes(EXCLUDE)) return;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    yield* fs.writeFileString(file, `${current}${separator}${EXCLUDE}\n`);
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

  const prepare = exclusive(
    Effect.gen(function* () {
      const existed = yield* fs.exists(gitDir);
      yield* fs.makeDirectory(input.cwd, { recursive: true });
      if (!existed) yield* git.run(["init", "-q", `--initial-branch=signalbox`]);
      for (const [key, value] of CONFIG) yield* git.run(["config", key, value]);
      yield* excludeCaches;
      const localThread = existed ? yield* git.resolve("refs/drive/thread") : null;
      const state = yield* drive.open;
      if (!existed || localThread !== state.thread) {
        conflicted = [];
        yield* checkout(state);
      }
      turnStart = yield* git.resolve("HEAD");
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
