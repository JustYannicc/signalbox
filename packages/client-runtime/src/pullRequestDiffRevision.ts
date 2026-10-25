import type { PullRequestDiffRevision } from "@t3tools/contracts";

/** Revisions are optional for self-hosted hosts that do not expose an immutable diff snapshot. */
export function samePullRequestDiffRevision(
  left: PullRequestDiffRevision | undefined,
  right: PullRequestDiffRevision | undefined,
): boolean {
  return left?.baseSha === right?.baseSha && left?.headSha === right?.headSha;
}

/** A guide can only use a cloud diff whose head matches the commit it was written for. */
export function isGuideDiffRevisionCurrent(
  guideHeadSha: string,
  revision: PullRequestDiffRevision | undefined,
): boolean {
  return revision === undefined || revision.headSha.toLowerCase() === guideHeadSha.toLowerCase();
}
