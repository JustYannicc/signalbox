import type { PullOperation, PullResult } from "@signalbox/runner-protocol/PullProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { EMPTY_TREE, type GitResult, RunnerGitError } from "./RunnerGit.ts";

interface PullGit {
  readonly exec: (args: ReadonlyArray<string>) => Effect.Effect<GitResult, RunnerGitError>;
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, RunnerGitError>;
  readonly resolve: (rev: string) => Effect.Effect<string | null, RunnerGitError>;
  readonly setRef: (ref: string, oid: string | null) => Effect.Effect<void, RunnerGitError>;
  readonly isAncestor: (
    ancestor: string,
    descendant: string,
  ) => Effect.Effect<boolean, RunnerGitError>;
}

const REBASE_DIRS = ["rebase-merge", "rebase-apply"];

const paths = (text: string) => text.split("\0").filter((path) => path !== "");

const overlaps = (left: string, right: string) =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** Applies one selected remote target without committing the user's working tree. */
export const applyPull = Effect.fn("applyRunnerPull")(function* (input: {
  readonly cwd: string;
  readonly gitDir: string;
  readonly git: PullGit;
  readonly operation: PullOperation;
  /** A private ref populated by the exact selected-branch fetch. */
  readonly source: string;
  readonly saveWip: (
    head: string,
  ) => Effect.Effect<
    string,
    RunnerGitError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { git, operation } = input;
  const currentHead = yield* git.resolve("HEAD");
  const dirty = (base = currentHead) =>
    Effect.gen(function* () {
      const [tracked, untracked, status] = yield* Effect.all([
        git.run(["diff", "--name-only", "-z", base ?? EMPTY_TREE]),
        git.run(["ls-files", "--others", "--exclude-standard", "-z"]),
        git.run(["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
      ]);
      return {
        paths: [...new Set([...paths(tracked), ...paths(untracked)])],
        changed: status.length > 0,
      };
    });
  const unchanged = (reason: string) =>
    Effect.map(
      dirty(),
      ({ changed }) =>
        ({
          id: operation.id,
          target: operation.target,
          head: operation.expectedThread,
          wip: operation.expectedWip,
          outcome: "refused",
          reason,
          hasWorkingTreeChanges: changed,
        }) satisfies PullResult,
    );

  if ((yield* git.resolve("MERGE_HEAD")) !== null) {
    return yield* unchanged("A merge is already in progress in this thread.");
  }
  for (const state of REBASE_DIRS) {
    if (yield* fs.exists(path.join(input.gitDir, state))) {
      return yield* unchanged("A rebase is already in progress in this thread.");
    }
  }

  const target = yield* git.resolve(operation.target);
  const source = yield* git.resolve(input.source);
  if (target !== operation.target || source === null) {
    return yield* unchanged("The selected remote commit is no longer available on its branch.");
  }
  if (!(yield* git.isAncestor(target, source))) {
    return yield* unchanged("The selected commit is no longer on the thread's remote branch.");
  }

  const head = yield* git.resolve("HEAD");
  let outcome: PullResult["outcome"] = "up_to_date";
  if (head !== operation.expectedThread) {
    // A replay after local apply but before the durable receipt may find the target already in HEAD.
    if (head === null || !(yield* git.isAncestor(target, head))) {
      return yield* unchanged("The thread's local branch changed after this pull was selected.");
    }
    if (
      operation.expectedThread === null ||
      !(yield* git.isAncestor(target, operation.expectedThread))
    ) {
      outcome = "pulled";
    }
  }

  let nextHead = head;
  if (head === null) {
    const local = yield* dirty();
    const remoteFiles = paths(yield* git.run(["diff", "--name-only", "-z", EMPTY_TREE, target]));
    if (
      local.paths.some((localPath) =>
        remoteFiles.some((remotePath) => overlaps(localPath, remotePath)),
      )
    ) {
      return yield* unchanged(
        "The selected commit changes files that already have local working tree changes.",
      );
    }
    yield* git.setRef("refs/heads/signalbox", target);
    yield* git.run(["symbolic-ref", "HEAD", "refs/heads/signalbox"]);
    yield* git.run(["read-tree", "-u", "--reset", target]);
    nextHead = target;
    outcome = "pulled";
  } else if (!(yield* git.isAncestor(target, head))) {
    if (!(yield* git.isAncestor(head, target))) {
      return yield* unchanged("The selected commit and this thread's branch have diverged.");
    }
    const local = yield* dirty();
    const remoteFiles = paths(yield* git.run(["diff", "--name-only", "-z", head, target]));
    if (
      local.paths.some((localPath) =>
        remoteFiles.some((remotePath) => overlaps(localPath, remotePath)),
      )
    ) {
      return yield* unchanged(
        "The selected commit changes files that already have local working tree changes.",
      );
    }
    const merged = yield* git.exec(["merge", "--ff-only", target]);
    if (merged.code !== 0) {
      return yield* unchanged(
        "Git could not fast-forward this thread's branch to the selected commit.",
      );
    }
    nextHead = yield* git.resolve("HEAD");
    if (nextHead !== target) {
      return yield* unchanged("Git did not move the thread's branch to the selected commit.");
    }
    outcome = "pulled";
  }

  if (nextHead === null) {
    return yield* unchanged("The thread has no branch to save after this pull.");
  }
  const wip = yield* input.saveWip(nextHead);
  const workingTree = yield* dirty(nextHead);
  return {
    id: operation.id,
    target: operation.target,
    head: nextHead,
    wip,
    outcome,
    reason: null,
    hasWorkingTreeChanges: workingTree.changed,
  } satisfies PullResult;
});
