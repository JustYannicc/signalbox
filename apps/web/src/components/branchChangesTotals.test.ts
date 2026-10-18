import { describe, expect, it } from "vite-plus/test";

import { resolveChangesTotals } from "./branchChangesTotals";

const workingTree = { files: [], insertions: 3, deletions: 1 };

describe("the Changes row's totals", () => {
  it("shows a branch that really changed nothing as zero", () => {
    expect(
      resolveChangesTotals({
        workingTree,
        branchChanges: { baseRef: "main", insertions: 0, deletions: 0 },
      }),
    ).toEqual({ kind: "counted", insertions: 0, deletions: 0 });
  });

  it("says why when the server couldn't count, instead of the working tree's zero", () => {
    expect(
      resolveChangesTotals({
        workingTree: { files: [], insertions: 0, deletions: 0 },
        branchChangesError: "Connect GitHub first: Settings › Source Control.",
      }),
    ).toEqual({
      kind: "unavailable",
      reason: "Connect GitHub first: Settings › Source Control.",
    });
  });

  it("keeps a self-hosted server's working tree when it reports no branch totals", () => {
    expect(resolveChangesTotals({ workingTree })).toEqual({
      kind: "counted",
      insertions: 3,
      deletions: 1,
    });
    expect(resolveChangesTotals(null)).toEqual({ kind: "counted", insertions: 0, deletions: 0 });
  });
});
