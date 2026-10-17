import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewFilePatchRequest, reviewSourceContentRefs } from "./review.ts";

const branchRange: ReviewDiffPreviewSource = {
  id: "branch-range",
  kind: "branch-range",
  title: "Changes vs main",
  baseRef: "main",
  headRef: "signalbox/0000abcd",
  diff: "",
  diffHash: "hash",
  truncated: true,
  files: [{ path: "src/app.ts", previousPath: null, additions: 1, deletions: 1 }],
};
const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const file = { path: "src/app.ts", previousPath: null };

describe("reading one file of a review source", () => {
  it("pins the file to the commits a cloud source compared, so a moved branch reads the same diff", () => {
    expect(
      reviewFilePatchRequest({
        cwd: "/drives/d/threads/t",
        source: { ...branchRange, revision },
        file,
        ignoreWhitespace: true,
      }),
    ).toEqual({
      cwd: "/drives/d/threads/t",
      baseRef: "main",
      ignoreWhitespace: true,
      file: { path: "src/app.ts", previousPath: null, sourceKind: "branch-range", revision },
    });
    expect(reviewSourceContentRefs({ ...branchRange, revision })).toEqual({
      baseRef: revision.baseSha,
      headRef: revision.headSha,
    });
  });

  it("reads a local source by its refs, falling back to the base the panel picked", () => {
    const local = { ...branchRange, baseRef: null };
    expect(
      reviewFilePatchRequest({ cwd: "/repo", source: local, file, fallbackBaseRef: "origin/dev" }),
    ).toEqual({
      cwd: "/repo",
      baseRef: "origin/dev",
      file: { path: "src/app.ts", previousPath: null, sourceKind: "branch-range" },
    });
    expect(reviewSourceContentRefs(branchRange)).toEqual({
      baseRef: "main",
      headRef: "signalbox/0000abcd",
    });
  });
});
