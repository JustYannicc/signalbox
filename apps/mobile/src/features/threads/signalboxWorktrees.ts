/**
 * signalbox: new threads on environments without worktrees (`worktrees`
 * capability, see `signalboxCapabilities.ts`). They start in the project
 * checkout only, so neither a new worktree nor a branch living in another
 * worktree is a choice there.
 */
import type { VcsRef } from "@t3tools/contracts";

type WorkspaceMode = "local" | "worktree";

/** The mode a new thread starts in: `chosen` (the draft's pick) only where worktrees exist. */
export function newThreadWorkspaceMode(input: {
  readonly supportsWorktrees: boolean;
  readonly chosen: WorkspaceMode | undefined;
  readonly fallback: WorkspaceMode;
}): WorkspaceMode {
  if (!input.supportsWorktrees) return "local";
  return input.chosen ?? input.fallback;
}

/** Whether the branch picker offers `branch`; one checked out in another worktree needs worktrees. */
export function offersNewThreadBranch(
  branch: Pick<VcsRef, "worktreePath">,
  input: { readonly supportsWorktrees: boolean; readonly workspaceRoot: string | null },
): boolean {
  return (
    input.supportsWorktrees || !branch.worktreePath || branch.worktreePath === input.workspaceRoot
  );
}
