import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { Candidate, EventReads } from "./candidate.ts";
import { makePullRequestTracker } from "./pullRequestFacts.ts";
import type { PullRequestReads, Remark } from "./pullRequestDetails.ts";

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

  it.effect(
    "reads remarks once per moved updatedAt and splits them into comments and reviews",
    () =>
      Effect.gen(function* () {
        const asked: string[] = [];
        const remark = (id: string, kind: Remark["kind"]): Remark => ({
          id,
          kind,
          author: "reviewer",
          body: id,
          path: null,
          reviewState: null,
          url: null,
          at: "2026-10-06T10:05:00.000Z",
        });
        const pullRequests: PullRequestReads = {
          remarksSince: (_ref, since) =>
            Effect.sync(() => {
              asked.push(since);
              return [remark("c1", "issue-comment"), remark("r1", "review")];
            }),
          failedChecks: () => Effect.succeed([{ name: "lint", status: "failure", url: null }]),
        };
        const reads = {
          shell: Effect.succeed(null),
          threads: {} as never,
          pullRequests,
        } satisfies EventReads;
        const build = (candidate: Candidate) => candidate.build(reads);

        const tracker = makePullRequestTracker(0);
        // The first snapshot has no "before": nothing to read since.
        expect(
          names(tracker, sync({ state: "open", updatedAt: "2026-10-06T10:00:00.000Z" })),
        ).toEqual([]);
        expect(
          names(tracker, sync({ state: "open", updatedAt: "2026-10-06T10:00:00.000Z" })),
        ).toEqual([]);
        const moved = tracker.observe(
          sync({ state: "open", updatedAt: "2026-10-06T10:05:00.000Z" }),
        );
        expect(moved.map((candidate) => candidate.name)).toEqual(["pr.commented", "pr.reviewed"]);
        expect(yield* build(moved[0]!)).toMatchObject({ number: 7, remarks: [{ id: "c1" }] });
        expect(yield* build(moved[1]!)).toMatchObject({ remarks: [{ id: "r1" }] });
        expect(asked).toEqual(["2026-10-06T10:00:00.000Z"]);

        // A read that failed still says something happened, once, without the details.
        const unread = tracker.observe(
          sync({ state: "open", updatedAt: "2026-10-06T10:09:00.000Z" }),
        );
        const blind = {
          ...reads,
          pullRequests: { ...pullRequests, remarksSince: () => Effect.succeed(null) },
        };
        expect(yield* unread[0]!.build(blind)).toMatchObject({ number: 7, remarks: null });
        expect(yield* unread[1]!.build(blind)).toBeNull();

        const [failed] = tracker.observe(
          sync({ state: "open", checksState: "failing", updatedAt: "2026-10-06T10:09:00.000Z" }),
        );
        expect(failed!.name).toBe("pr.checks.failed");
        expect(yield* build(failed!)).toMatchObject({ failedChecks: [{ name: "lint" }] });
      }),
  );
});
