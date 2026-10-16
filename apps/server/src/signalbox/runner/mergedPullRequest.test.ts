import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mergedPullRequestOf } from "./mergedPullRequest.ts";

const branch = "signalbox/thread01";
const link = (
  number: number,
  linkedAt: string,
  snapshot: { readonly state: "open" | "closed" | "merged"; readonly headBranch?: string } | null,
  change: Partial<ThreadPullRequestLink> = {},
) =>
  ({
    host: "github.com",
    repository: "owner/repo",
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    source: "created",
    linkedAt,
    snapshot:
      snapshot === null
        ? null
        : {
            state: snapshot.state,
            title: "Feature",
            headBranch: snapshot.headBranch ?? branch,
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: linkedAt,
          },
    stack: null,
    ...change,
  }) as ThreadPullRequestLink;

const merged = (links: ReadonlyArray<ThreadPullRequestLink>) =>
  mergedPullRequestOf(links, { branch, repository: "Owner/Repo" });

describe("mergedPullRequestOf", () => {
  it("names the branch's pull request once it merged", () => {
    expect(merged([])).toBeNull();
    expect(merged([link(7, "2026-10-16T10:00:00Z", { state: "open" })])).toBeNull();
    expect(merged([link(7, "2026-10-16T10:00:00Z", { state: "merged" })])).toBe(7);
  });

  it("follows the branch's newest pull request: a newer open or unread one keeps it as it is", () => {
    const first = link(7, "2026-10-16T10:00:00Z", { state: "merged" });
    expect(merged([first, link(9, "2026-10-16T11:00:00Z", { state: "open" })])).toBeNull();
    expect(merged([first, link(9, "2026-10-16T11:00:00Z", null)])).toBeNull();
    expect(merged([first, link(9, "2026-10-16T11:00:00Z", { state: "merged" })])).toBe(9);
    // Linked in either order, the newest decides.
    expect(merged([link(9, "2026-10-16T11:00:00Z", { state: "open" }), first])).toBeNull();
  });

  it("ignores other branches, other repositories and dismissed links", () => {
    const mine = link(7, "2026-10-16T10:00:00Z", { state: "merged" });
    expect(
      merged([mine, link(8, "2026-10-16T11:00:00Z", { state: "open", headBranch: "feature" })]),
    ).toBe(7);
    expect(
      merged([
        mine,
        link(8, "2026-10-16T11:00:00Z", { state: "open" }, { repository: "owner/other" }),
      ]),
    ).toBe(7);
    expect(
      merged([
        mine,
        link(8, "2026-10-16T11:00:00Z", { state: "open" }, { source: "stack-dismissed" }),
      ]),
    ).toBe(7);
  });
});
