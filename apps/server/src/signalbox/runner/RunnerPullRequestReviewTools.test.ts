import * as NodeServices from "@effect/platform-node/NodeServices";
import { PULL_REQUEST_REVIEW_TOOL } from "@signalbox/runner-protocol/PullRequestReviewTools";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { serve, TOKEN } from "./RunnerAutomationTools.testkit.ts";

describe("folder agent PR collaboration reach", () => {
  it.effect("publishes the folder review tool without caller-controlled identity fields", () =>
    Effect.gen(function* () {
      const { mcp } = yield* serve();
      const listed = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        description: string;
        inputSchema: { properties?: Record<string, unknown> };
        annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
      }>;
      const tool = listed.find(({ name }) => name === PULL_REQUEST_REVIEW_TOOL);
      expect(tool).toBeDefined();
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(tool?.description).toContain("current headSha");
      expect(tool?.description).toContain("headSha from the read result");
      expect(tool?.description).toContain("reuse the same operationId when retrying");
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining([
          "action",
          "number",
          "threadId",
          "resolved",
          "operationId",
          "commentId",
          "kind",
          "headSha",
          "verdict",
          "comments",
          "subjectId",
          "content",
          "reacted",
        ]),
      );
      for (const field of ["repository", "projectId", "folderId", "token", "identity", "userId"]) {
        expect(tool?.inputSchema.properties).not.toHaveProperty(field);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("forwards all review actions through the thread token and retries only reads", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve();
      const reviewedHeadSha = "a".repeat(40);
      cloud.answers.push(503, {
        _tag: "ok",
        result: { reviewThreads: [], headSha: reviewedHeadSha },
      });
      const read = yield* call(PULL_REQUEST_REVIEW_TOOL, { action: "read", number: 12 });
      expect(read.isError).toBeUndefined();
      expect(JSON.parse(read.content[0]!.text)).toEqual({
        reviewThreads: [],
        headSha: reviewedHeadSha,
      });
      expect(cloud.requests).toHaveLength(2);

      cloud.answers.push(503);
      expect(
        yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "comment",
          number: 12,
          body: "Thanks.",
          operationId: "comment-1",
        }),
      ).toMatchObject({ isError: true });
      expect(cloud.requests).toHaveLength(3);

      for (let i = 0; i < 5; i += 1) {
        cloud.answers.push({ _tag: "ok", result: { written: true } });
      }
      const writes = [
        { action: "reply", number: 12, threadId: "PRRT_1", body: "Fixed.", operationId: "reply-1" },
        { action: "resolve", number: 12, threadId: "PRRT_1", resolved: true },
        {
          action: "updateComment",
          number: 12,
          commentId: "IC_1",
          kind: "issue-comment",
          body: "Updated.",
        },
        {
          action: "submitReview",
          number: 12,
          operationId: "review-1",
          headSha: reviewedHeadSha,
          verdict: "approve",
          body: "Reviewed.",
          comments: [],
        },
        {
          action: "setReaction",
          number: 12,
          subjectId: "PRRC_1",
          content: "thumbs-up",
          reacted: true,
        },
      ];
      for (const input of writes) {
        const answer = yield* call(PULL_REQUEST_REVIEW_TOOL, input);
        expect(answer.isError).toBeUndefined();
      }

      expect(cloud.requests.map(({ name, input }) => ({ name, input }))).toEqual([
        { name: PULL_REQUEST_REVIEW_TOOL, input: { action: "read", number: 12 } },
        { name: PULL_REQUEST_REVIEW_TOOL, input: { action: "read", number: 12 } },
        {
          name: PULL_REQUEST_REVIEW_TOOL,
          input: { action: "comment", number: 12, body: "Thanks.", operationId: "comment-1" },
        },
        { name: PULL_REQUEST_REVIEW_TOOL, input: writes[0] },
        { name: PULL_REQUEST_REVIEW_TOOL, input: writes[1] },
        { name: PULL_REQUEST_REVIEW_TOOL, input: writes[2] },
        { name: PULL_REQUEST_REVIEW_TOOL, input: writes[3] },
        { name: PULL_REQUEST_REVIEW_TOOL, input: writes[4] },
      ]);
      expect(cloud.requests.every(({ bearer }) => bearer === `Bearer ${TOKEN}`)).toBe(true);
      expect(JSON.stringify(cloud.requests)).not.toContain("github-token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects missing idempotency or head pins before cloud dispatch", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve();
      expect(
        yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "comment",
          number: 12,
          body: "Thanks.",
        }),
      ).toMatchObject({ isError: true });
      expect(
        yield* call(PULL_REQUEST_REVIEW_TOOL, {
          action: "submitReview",
          number: 12,
          operationId: "review-1",
          verdict: "approve",
          body: "Reviewed.",
          comments: [],
        }),
      ).toMatchObject({ isError: true });
      expect(cloud.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
