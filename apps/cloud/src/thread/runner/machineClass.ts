import type { MachineClass } from "@signalbox/runner-protocol/RunnerProtocol";

import { threadWorktreeAt } from "../../user/contextProjects.ts";

/**
 * Which machine class a thread runs on (#113):
 *
 * |           | Remote repo | No remote repo |
 * |-----------|-------------|----------------|
 * | Task      | heavy       | light          |
 * | Chat      | light       | light          |
 * | Chat room | light       | light          |
 *
 * Light runs the harness and its subagents editing files; heavy builds, tests
 * and runs dev servers. A thread on a light machine moves up for good when a
 * command needs more (`machine.outgrown` from its Runner, or its machine dying
 * mid-turn), by resuming on a heavy one the way a lost machine does (#132).
 *
 * Chat or task is only how a thread shows, so the thread's drive decides: a
 * thread created in a drive backed by a remote repo gets its own branch there
 * (`remoteThreadWorktree`, #135), and that is a task's; every other drive has
 * no remote.
 */
export const machineClassFor = (thread: {
  /** The thread's working tree, as its app thread records it. */
  readonly worktreePath: string | null;
  /** Whether the thread already moved up. */
  readonly movedUp: boolean;
}): MachineClass =>
  thread.movedUp || (thread.worktreePath !== null && threadWorktreeAt(thread.worktreePath) !== null)
    ? "heavy"
    : "light";
