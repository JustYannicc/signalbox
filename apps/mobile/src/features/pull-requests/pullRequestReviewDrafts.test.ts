import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  clearCommentWriteAttempt,
  clearSubmittedReview,
  pullRequestReviewKey,
  ReviewDraftDocument,
  type ReviewDraft,
} from "./pullRequestReviewDrafts";
const decodeDocument = Schema.decodeUnknownSync(ReviewDraftDocument);
const comment = {
  id: "one",
  path: "renamed.ts",
  oldPath: "old.ts",
  position: { kind: "deleted" as const, oldLine: 9 },
  body: "Keep this",
  headSha: "abc",
  code: "old line",
};
const draft: ReviewDraft = {
  summary: "Review",
  comment: "Separate PR comment",
  comments: [comment],
};
describe("mobile review draft recovery", () => {
  it("round trips renamed/deleted line anchors and a separate unsent PR comment", () => {
    const saved = JSON.stringify({ version: 1, drafts: { key: draft } });
    expect(decodeDocument(JSON.parse(saved)).drafts.key).toEqual(draft);
  });
  it("persists failed write attempts and clears them only after the matching success", () => {
    const attempt = { requestKey: "request", operationId: "operation-1", headSha: "head-a" };
    const withAttempts: ReviewDraft = {
      ...draft,
      reviewedHeadSha: "head-a",
      reviewWriteAttempt: attempt,
      commentWriteAttempt: { ...attempt, operationId: "operation-2" },
    };
    const restored = decodeDocument(
      JSON.parse(JSON.stringify({ version: 1, drafts: { key: withAttempts } })),
    ).drafts.key;

    expect(restored).toEqual(withAttempts);
    expect(clearSubmittedReview(restored, draft).reviewWriteAttempt).toBeUndefined();
    expect(clearCommentWriteAttempt(restored, "other-operation")).toBe(restored);
    expect(clearCommentWriteAttempt(restored, "operation-2").commentWriteAttempt).toBeUndefined();
  });
  it("rejects a damaged document instead of replacing drafts with an empty file", () => {
    expect(() =>
      decodeDocument({
        version: 1,
        drafts: {
          key: { ...draft, comments: [{ ...comment, position: { kind: "deleted", oldLine: 0 } }] },
        },
      }),
    ).toThrow();
  });
  it("clears a submitted snapshot while retaining edits made during the request", () => {
    const current = {
      ...draft,
      summary: "New summary",
      comments: [
        { ...comment, body: "New feedback" },
        { ...comment, id: "two" },
      ],
    };
    expect(clearSubmittedReview(current, draft)).toEqual(current);
    expect(clearSubmittedReview(draft, draft)).toEqual({
      summary: "",
      comment: draft.comment,
      comments: [],
    });
  });
  it("does not mix identical PR numbers across repositories, hosts, or environments", () => {
    const ref = {
      environmentId: "a",
      projectId: "p",
      host: "github.com",
      repository: "one/repo",
      number: 1,
    };
    expect(
      new Set(
        [
          ref,
          { ...ref, environmentId: "b" },
          { ...ref, host: "github.enterprise" },
          { ...ref, repository: "two/repo" },
        ].map(pullRequestReviewKey),
      ).size,
    ).toBe(4);
  });
  it("retains a draft reanchored while its earlier position was being submitted", () => {
    const current = {
      ...draft,
      comments: [{ ...comment, position: { kind: "deleted" as const, oldLine: 12 } }],
    };
    expect(clearSubmittedReview(current, draft).comments).toEqual(current.comments);
  });
});
