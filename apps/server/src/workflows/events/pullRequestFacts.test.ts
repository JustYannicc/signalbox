import { describe, expect, it } from "vite-plus/test";

import { makePullRequestTracker } from "./pullRequestFacts.ts";

const sync = (snapshot: Record<string, unknown> | null, syncedAt = "2026-10-06T10:00:00.000Z") =>
  ({
    threadId: "thread-1",
    payload: {
      projectId: "project-1",
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          source: "agent",
          snapshot: snapshot && {
            title: "T",
            headBranch: "h",
            baseBranch: "main",
            isDraft: false,
            syncedAt,
            ...snapshot,
          },
        },
      ],
    },
  }) as never;

const names = (tracker: ReturnType<typeof makePullRequestTracker>, event: unknown) =>
  tracker.observe(event as never).map((candidate) => candidate.name);

describe("pull request facts", () => {
  it("turns snapshot changes into pr.* events, once per transition", () => {
    const tracker = makePullRequestTracker(0);
    expect(names(tracker, sync(null))).toEqual([]);
    expect(names(tracker, sync({ state: "open", checksState: "pending" }))).toEqual([]);
    expect(names(tracker, sync({ state: "open", checksState: "failing" }))).toEqual([
      "pr.checks.failed",
    ]);
    expect(names(tracker, sync({ state: "open", checksState: "failing" }))).toEqual([]);
    expect(
      names(tracker, sync({ state: "open", checksState: "passing", mergeability: "conflicting" })),
    ).toEqual(["pr.checks.passed", "pr.conflicted"]);
    const [merged] = tracker.observe(sync({ state: "merged", checksState: "passing" }));
    expect(merged).toMatchObject({
      name: "pr.merged",
      id: "pr.merged:thread-1:github.com/acme/app#7",
      projectId: "project-1",
    });
  });

  it("after a restart, counts only state synced since then", () => {
    const tracker = makePullRequestTracker(Date.parse("2026-10-06T12:00:00.000Z"));
    expect(names(tracker, sync({ state: "merged" }, "2026-10-06T10:00:00.000Z"))).toEqual([]);
    const fresh = makePullRequestTracker(Date.parse("2026-10-06T12:00:00.000Z"));
    expect(names(fresh, sync({ state: "merged" }, "2026-10-06T12:30:00.000Z"))).toEqual([
      "pr.merged",
    ]);
  });
});
