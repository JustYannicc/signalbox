import type { MachineClass } from "@signalbox/runner-protocol/RunnerProtocol";

/**
 * Every new thread starts light, including one with a remote repo. Light runs
 * the harness and its subagents editing files; a command that needs more moves
 * it to a heavy machine for good. The Runner saves the files and session, then
 * the thread resumes the run there as it does after a lost machine (#132).
 * Every later wake stays heavy. Any other exit, such as a deploy restarting
 * the machine (#555), keeps the thread in its current class.
 */
export const machineClassFor = (thread: {
  /** The thread's working tree, as its app thread records it. */
  readonly worktreePath: string | null;
  /** Whether the thread already moved up. */
  readonly movedUp: boolean;
}): MachineClass => (thread.movedUp ? "heavy" : "light");
