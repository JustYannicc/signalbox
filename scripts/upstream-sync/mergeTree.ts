// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI script, run by signalbox-ci.yml and upstream-sync.yml.
/**
 * Asks git whether two commits merge cleanly, without touching the working
 * tree or index. Shared by the PR merge check and the scheduled upstream sync.
 */
import * as NodeChildProcess from "node:child_process";

export function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

/** True when `ancestor` is reachable from `descendant`. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd, stdio: "ignore" },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} failed`);
}

/**
 * Files that conflict when merging `theirs` into `ours`, sorted. Empty when the
 * merge is clean. Needs both commits and their merge base locally.
 */
export function conflictingFiles(cwd: string, ours: string, theirs: string): string[] {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  // Exit 0 is clean, 1 is conflicted; anything else (missing merge base, bad ref) is an error.
  if (result.status === 0) return [];
  if (result.status !== 1) {
    throw new Error(`git merge-tree ${ours} ${theirs} failed: ${result.stderr.trim()}`);
  }
  // First line is the (conflicted) tree id, then one conflicted path per line.
  const files = result.stdout.split("\n").slice(1).filter(Boolean);
  return [...new Set(files)].toSorted();
}

export function mergedHead(
  cwd: string,
  base: string,
  head: string,
  allowConflicts = false,
): string {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--no-messages", base, head],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  // Only the advisory upstream report may fall back to the unmerged head.
  // Enforced checks must reject an unresolved merge with the current target.
  if (result.status === 1 && allowConflicts) return head;
  if (result.status !== 0) {
    throw new Error(`git merge-tree ${base} ${head} failed: ${result.stderr.trim()}`);
  }
  // A tree alone has no merge ancestry. This unreferenced commit preserves both
  // parents without touching the index, worktree, refs or repository identity.
  return git(cwd, [
    "-c",
    "user.name=ci",
    "-c",
    "user.email=ci@localhost",
    "commit-tree",
    result.stdout.trim(),
    "-p",
    base,
    "-p",
    head,
    "-m",
    "Upstream merge check",
  ]);
}

/** Conflicts the PR's merge into the current base adds over that base. */
export function introducedConflicts(
  cwd: string,
  refs: { readonly base: string; readonly head: string; readonly upstream: string },
): { readonly introduced: string[]; readonly preexisting: string[] } {
  const candidate = mergedHead(cwd, refs.base, refs.head, true);
  const head = conflictingFiles(cwd, candidate, refs.upstream);
  if (head.length === 0) return { introduced: [], preexisting: [] };
  const base = new Set(conflictingFiles(cwd, refs.base, refs.upstream));
  return {
    introduced: head.filter((file) => !base.has(file)),
    preexisting: head.filter((file) => base.has(file)),
  };
}
