import { describe, expect, it } from "vite-plus/test";
import type { PullRequestDiffResult } from "@t3tools/contracts";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { combinePullRequestDiffPages, retainPullRequestDiffPage } from "./pullRequestDiffPages";

function diff(path: string, revision?: PullRequestDiffResult["revision"]): PullRequestDiffResult {
  return {
    ...(revision === undefined ? {} : { revision }),
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    truncated: false,
    nextCursor: null,
  };
}

describe("paged mobile pull request diffs", () => {
  it("retains file order and IDs when another page arrives", () => {
    const first = { ...diff("first.ts"), nextCursor: "second" };
    const pages = retainPullRequestDiffPage([], null, first);
    const cache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();
    const before = combinePullRequestDiffPages(pages, cache, "pr");
    const after = combinePullRequestDiffPages(
      retainPullRequestDiffPage(pages, "second", diff("second.ts")),
      cache,
      "pr",
    );
    expect(before.kind).toBe("files");
    expect(after.kind).toBe("files");
    if (before.kind !== "files" || after.kind !== "files")
      throw new Error("Expected structured diff");
    expect(after.files.map((file) => file.path)).toEqual(["first.ts", "second.ts"]);
    expect(after.files[0]).toBe(before.files[0]);
    expect(after.additions).toBe(2);
  });

  it("discards later pages when a refreshed page changes", () => {
    const first = diff("first.ts");
    const pages = retainPullRequestDiffPage(
      retainPullRequestDiffPage([], null, first),
      "second",
      diff("second.ts"),
    );
    expect(retainPullRequestDiffPage(pages, null, first)).toBe(pages);
    expect(retainPullRequestDiffPage(pages, null, { ...first })).toBe(pages);
    const refreshed = retainPullRequestDiffPage(pages, null, diff("changed.ts"));
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.result.patch).toContain("changed.ts");
  });

  it("discards continuations from a different immutable comparison", () => {
    const firstRevision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
    const movedRevision = { baseSha: "c".repeat(40), headSha: "d".repeat(40) };
    const pages = retainPullRequestDiffPage(
      retainPullRequestDiffPage([], null, {
        ...diff("first.ts", firstRevision),
        nextCursor: "second",
      }),
      "second",
      diff("second.ts", firstRevision),
    );

    expect(retainPullRequestDiffPage(pages, "second", diff("moved.ts", movedRevision))).toEqual([]);
  });

  it("resets later pages when the first page's revision moves even if its patch is unchanged", () => {
    const firstRevision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
    const movedRevision = { baseSha: "c".repeat(40), headSha: "d".repeat(40) };
    const first = { ...diff("first.ts", firstRevision), nextCursor: "second" };
    const pages = retainPullRequestDiffPage(
      retainPullRequestDiffPage([], null, first),
      "second",
      diff("second.ts", firstRevision),
    );

    const refreshed = retainPullRequestDiffPage(pages, null, {
      ...first,
      revision: movedRevision,
    });

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.result.patch).toBe(first.patch);
    expect(refreshed[0]?.result.revision).toEqual(movedRevision);
  });
});
