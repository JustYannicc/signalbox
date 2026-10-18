import type { GitPreparePullRequestThreadResult, ThreadId } from "@t3tools/contracts";

type PreparationMode = "local" | "worktree";

/**
 * The cloud keys its preparation receipt on this id together with the exact request, so a retry
 * must repeat both: the same draft thread, the same reference string and the same mode give the
 * same id, and anything else is a different preparation.
 */
export function pullRequestThreadPreparationOperationId(input: {
  readonly threadId: ThreadId;
  readonly reference: string;
  readonly mode: PreparationMode;
}): string {
  return `pull-request-thread:${input.threadId}:${input.mode}:${input.reference}`;
}

/** The outbox already retries under one command id; preparation follows it. */
export function queuedPullRequestThreadOperationId(commandId: string): string {
  return `${commandId}:pull-request`;
}

export type PreparedPullRequestThread =
  /** The server made (or reused) the requested thread; it carries the pull request's head. */
  | { readonly kind: "server-thread"; readonly threadId: ThreadId }
  /** A self-hosted checkout: the client still points its draft at the branch it reports. */
  | {
      readonly kind: "host-checkout";
      readonly branch: string;
      readonly worktreePath: string | null;
      readonly isOnPullRequestHead: boolean;
    }
  /** The server answered for another thread, which the requested one never allows. */
  | { readonly kind: "mismatch"; readonly threadId: ThreadId };

export function resolvePreparedPullRequestThread(
  requestedThreadId: ThreadId,
  result: GitPreparePullRequestThreadResult,
): PreparedPullRequestThread {
  if (result.threadId === undefined) {
    return {
      kind: "host-checkout",
      branch: result.branch,
      worktreePath: result.worktreePath,
      isOnPullRequestHead: result.isOnPullRequestHead,
    };
  }
  return result.threadId === requestedThreadId
    ? { kind: "server-thread", threadId: result.threadId }
    : { kind: "mismatch", threadId: result.threadId };
}
