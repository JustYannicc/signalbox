import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

/**
 * The thread's pull request whose merge its branch takes in at the next turn
 * start (#495): the one most recently linked from the thread's own `branch`
 * on `repository`, when GitHub last said it merged. Null when that one is
 * open, closed or not read yet, or the branch has none: an open pull request
 * keeps its branch as the agent left it.
 */
export function mergedPullRequestOf(
  links: ReadonlyArray<ThreadPullRequestLink>,
  input: { readonly branch: string; readonly repository: string },
): number | null {
  const repository = input.repository.toLowerCase();
  // A link not read yet may be the branch's newest pull request: it counts until GitHub says.
  const own = visibleThreadPullRequests(links).filter(
    (link) =>
      link.repository.toLowerCase() === repository &&
      (link.snapshot === null || link.snapshot.headBranch === input.branch),
  );
  const latest = own.reduce<ThreadPullRequestLink | null>(
    (newest, link) => (newest === null || link.linkedAt >= newest.linkedAt ? link : newest),
    null,
  );
  return latest?.snapshot?.state === "merged" ? latest.number : null;
}
