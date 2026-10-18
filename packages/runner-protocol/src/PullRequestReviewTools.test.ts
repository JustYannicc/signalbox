import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { Request } from "@signalbox/runner-protocol/PullRequestReviewTools";

const decode = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" });

describe("pull request review tool requests", () => {
  it("accepts the four folder collaboration writes with their action-specific fields", () => {
    expect(
      decode({ action: "comment", number: 12, body: "Thanks.", operationId: "comment-1" }),
    ).toMatchObject({ action: "comment", number: 12, operationId: "comment-1" });
    expect(
      decode({
        action: "updateComment",
        number: 12,
        commentId: "IC_1",
        kind: "issue-comment",
        body: "Updated.",
      }),
    ).toMatchObject({ action: "updateComment", commentId: "IC_1" });
    expect(
      decode({
        action: "submitReview",
        number: 12,
        operationId: "review-1",
        headSha: "a".repeat(40),
        verdict: "approve",
        body: "Reviewed.",
        comments: [],
      }),
    ).toMatchObject({ action: "submitReview", headSha: "a".repeat(40) });
    expect(
      decode({
        action: "setReaction",
        number: 12,
        content: "thumbs-up",
        reacted: true,
      }),
    ).toMatchObject({ action: "setReaction", content: "thumbs-up", reacted: true });
  });

  it("requires an idempotency key and reviewed head for the cloud-backed create operations", () => {
    expect(() => decode({ action: "comment", number: 12, body: "Thanks." })).toThrow();
    expect(() =>
      decode({
        action: "submitReview",
        number: 12,
        operationId: "review-1",
        verdict: "approve",
        body: "Reviewed.",
        comments: [],
      }),
    ).toThrow();
  });

  it("rejects caller-supplied repository and identity fields", () => {
    expect(() =>
      decode({
        action: "comment",
        number: 12,
        body: "Thanks.",
        operationId: "comment-1",
        repository: "other/private",
        folderId: "other-folder",
        token: "github-secret",
        identity: "other-person",
      }),
    ).toThrow();
  });
});
