import { describe, expect, it } from "vite-plus/test";

import {
  isGuideDiffRevisionCurrent,
  samePullRequestDiffRevision,
} from "./pullRequestDiffRevision.ts";

const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

describe("pull request diff revisions", () => {
  it("compares both immutable sides and treats two absent revisions as equal", () => {
    expect(samePullRequestDiffRevision(revision, { ...revision })).toBe(true);
    expect(samePullRequestDiffRevision(revision, { ...revision, headSha: "c".repeat(40) })).toBe(
      false,
    );
    expect(samePullRequestDiffRevision(undefined, undefined)).toBe(true);
  });

  it("rejects guide diffs from another head and accepts revision-less self-host diffs", () => {
    expect(isGuideDiffRevisionCurrent(revision.headSha, revision)).toBe(true);
    expect(
      isGuideDiffRevisionCurrent(revision.headSha, { ...revision, headSha: "c".repeat(40) }),
    ).toBe(false);
    expect(isGuideDiffRevisionCurrent("guide-head", undefined)).toBe(true);
  });
});
