import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import { AgentPullRequestError } from "./agentPullRequestError.ts";
import { makeGitHubCollaborationWrites } from "./GitHubCollaborationWrites.ts";
import { makePullRequestDiscussion } from "./PullRequestDiscussion.ts";
import { fixture, reference, storage } from "./pullRequestCollaborationTesting.ts";

vi.mock("./GitHubCollaborationWrites.ts", () => ({ makeGitHubCollaborationWrites: vi.fn() }));

const comment = { ...reference, body: "The fix is ready.", operationId: "comment-1" };
const review = {
  ...reference,
  verdict: "approve" as const,
  body: "Reviewed the change.",
  comments: [],
  headSha: "a".repeat(40),
  operationId: "review-1",
};
const setup = Effect.gen(function* () {
  const f = yield* fixture;
  const state = {
    prepared: 0,
    written: 0,
    edits: 0,
    reactions: 0,
    refreshes: 0,
    failure: null as AgentPullRequestError | null,
    preparationFailure: null as AgentPullRequestError | null,
    beforeWrite: Effect.void as Effect.Effect<void>,
  };
  const prepare = () =>
    Effect.gen(function* () {
      state.prepared += 1;
      if (state.preparationFailure !== null) return yield* state.preparationFailure;
      return Effect.gen(function* () {
        state.written += 1;
        yield* state.beforeWrite;
        if (state.failure !== null) return yield* state.failure;
        return { providerId: `provider-${state.written}` };
      });
    });
  vi.mocked(makeGitHubCollaborationWrites).mockReturnValue({
    prepareComment: prepare,
    prepareReview: prepare,
    updateComment: () =>
      Effect.sync(() => {
        state.edits += 1;
        return undefined;
      }),
    setReaction: () =>
      Effect.sync(() => {
        state.reactions += 1;
        return undefined;
      }),
  });
  const make = makePullRequestDiscussion(() =>
    Effect.sync(() => {
      state.refreshes += 1;
    }),
  ).pipe(Effect.provide(f.dependencies));
  return {
    ...f,
    state: { ...f.state, writes: state },
    source: f.state,
    makeDiscussion: make,
    discussion: yield* make,
  };
});

describe("cloud PR discussion receipts", () => {
  it.effect(
    "replays comments and reviews after service reconstruction without preparing another write",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.discussion.comment(comment);
        yield* f.discussion.submitReview(review);
        const restarted = yield* f.makeDiscussion;
        yield* restarted.comment(comment);
        yield* restarted.submitReview(review);
        expect(f.state.writes).toMatchObject({ prepared: 2, written: 2, refreshes: 4 });
        const rows = yield* f.sql<{
          result: string;
          status: string;
        }>`SELECT result, status FROM agent_pull_request_operations ORDER BY operation_id`;
        expect(rows.map((r) => r.status)).toEqual(["finished", "finished"]);
        expect(rows.map((r) => JSON.parse(r.result))).toEqual([
          { providerId: "provider-1" },
          { providerId: "provider-2" },
        ]);
      }).pipe(Effect.provide(storage)),
  );

  it.effect(
    "rejects changed content, review heads and acting accounts under an existing operation id",
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.discussion.comment(comment);
        yield* f.discussion.submitReview(review);
        expect(
          yield* f.discussion.comment({ ...comment, body: "Other." }).pipe(Effect.flip),
        ).toMatchObject({ reason: "operation-conflict" });
        expect(
          yield* f.discussion
            .submitReview({ ...review, headSha: "b".repeat(40) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "operation-conflict" });
        f.source.accountId = "other-actor";
        expect(yield* f.discussion.comment(comment).pipe(Effect.flip)).toMatchObject({
          reason: "operation-conflict",
        });
        expect(f.state.writes.written).toBe(2);
      }).pipe(Effect.provide(storage)),
  );

  it.effect("keeps lost comment and review responses pending instead of duplicating them", () =>
    Effect.gen(function* () {
      for (const kind of ["comment", "submitReview"] as const) {
        const f = yield* setup;
        f.state.writes.failure = AgentPullRequestError.forCategory("unavailable", 0);
        if (kind === "comment") yield* f.discussion.comment(comment).pipe(Effect.flip);
        else yield* f.discussion.submitReview(review).pipe(Effect.flip);
        f.state.writes.failure = null;
        const restarted = yield* f.makeDiscussion;
        const retry =
          kind === "comment" ? restarted.comment(comment) : restarted.submitReview(review);
        expect(yield* retry.pipe(Effect.flip)).toMatchObject({ reason: "pending" });
        expect(f.state.writes).toMatchObject({ written: 1, refreshes: 0 });
      }
    }).pipe(Effect.provide(storage)),
  );

  it.effect("allows retry after a definite provider rate-limit refusal", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      f.state.writes.failure = AgentPullRequestError.forCategory("unavailable", 429, 123456);
      expect(yield* f.discussion.submitReview(review).pipe(Effect.flip)).toMatchObject({
        reason: "rate-limit",
        retryAt: 123456,
      });
      f.state.writes.failure = null;
      yield* f.discussion.submitReview(review);
      yield* f.discussion.submitReview(review);
      expect(f.state.writes).toMatchObject({ written: 2, refreshes: 2 });
    }).pipe(Effect.provide(storage)),
  );

  it.effect("does not reserve an operation when the provider preflight fails", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      f.state.writes.preparationFailure = AgentPullRequestError.forCategory("unavailable", 0);
      expect(yield* f.discussion.submitReview(review).pipe(Effect.flip)).toMatchObject({
        _tag: "PullRequestOperationError",
        status: 0,
      });
      const rows = yield* f.sql`SELECT * FROM agent_pull_request_operations`;
      expect(rows).toHaveLength(0);
      f.state.writes.preparationFailure = null;
      yield* f.discussion.submitReview(review);
      expect(f.state.writes).toMatchObject({ prepared: 2, written: 1, refreshes: 1 });
    }).pipe(Effect.provide(storage)),
  );

  it.effect("claims a concurrent comment retry before a second provider mutation", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.state.writes.beforeWrite = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const first = yield* f.discussion.comment(comment).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(yield* f.discussion.comment(comment).pipe(Effect.flip)).toMatchObject({
        reason: "pending",
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(f.state.writes.written).toBe(1);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("checks current folder authority even for a completed receipt", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.discussion.comment(comment);
      f.source.role = "viewer";
      expect(yield* f.discussion.comment(comment).pipe(Effect.flip)).toMatchObject({
        reason: "permission",
      });
      expect(
        yield* f.discussion
          .updateComment({
            ...reference,
            commentId: "IC_1",
            kind: "issue-comment",
            body: "Edited.",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "permission" });
      expect(
        yield* f.discussion
          .setReaction({ ...reference, content: "thumbs-up", reacted: true })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "permission" });
      expect(f.state.writes).toMatchObject({ written: 1, edits: 0, reactions: 0 });
    }).pipe(Effect.provide(storage)),
  );

  it.effect("requires operation ids and the reviewed head before allocating receipts", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      expect(
        yield* f.discussion.comment({ ...comment, operationId: undefined }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid" });
      expect(
        yield* f.discussion.submitReview({ ...review, headSha: undefined }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid" });
      expect(
        yield* f.discussion.comment({ ...comment, body: "   " }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid" });
      const rows = yield* f.sql`SELECT * FROM agent_pull_request_operations`;
      expect(rows).toHaveLength(0);
      expect(f.state.writes.written).toBe(0);
    }).pipe(Effect.provide(storage)),
  );
});
