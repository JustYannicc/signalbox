import type { ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import type { WorktreeSetupActionStatus } from "@t3tools/client-runtime/worktree-setup";

/** A subscription can close or replay an older value during the setup handoff. */
export function resolveWorktreeSetupSnapshot(
  threadId: ThreadId | null,
  latest: WorktreeSetupSnapshot | null | undefined,
  held: WorktreeSetupSnapshot | null,
): WorktreeSetupSnapshot | null {
  const current = latest?.threadId === threadId ? latest : null;
  const previous = held?.threadId === threadId ? held : null;
  return current && (!previous || current.sequence >= previous.sequence) ? current : previous;
}

/**
 * What the composer's stop does. Before the agent handoff it cancels setup,
 * and only once a snapshot names the attempt: Cloud rejects an unguarded stop,
 * and a run interrupt would end the attempt as unretryable.
 */
export function resolveComposerStop(input: {
  awaitingSetup: boolean;
  setupCancel: WorktreeSetupActionStatus | null;
  interruptible: boolean;
}): "cancel-setup" | "interrupt" | null {
  if (input.awaitingSetup) return input.setupCancel === "available" ? "cancel-setup" : null;
  return input.interruptible ? "interrupt" : null;
}
