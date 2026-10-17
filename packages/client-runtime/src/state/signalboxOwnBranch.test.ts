import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMenuItems, resolveQuickAction } from "./gitActions.ts";
import { ownBranchMenuItems, ownBranchQuickAction } from "./signalboxOwnBranch.ts";

// A cloud thread's branch as the cloud reports it: always clean, on a GitHub remote.
const branch = (overrides: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "signalbox/0000abcd",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
  ...overrides,
});

describe("own-branch git actions", () => {
  it("drops Commit and keeps Push and Create PR", () => {
    const items = ownBranchMenuItems(buildMenuItems(branch({ aheadCount: 2 }), false));
    expect(items.map((item) => [item.id, item.disabled])).toEqual([
      ["push", false],
      ["pr", true],
    ]);
  });

  it("names an up-to-date branch's quick action Push, still disabled with its hint", () => {
    expect(ownBranchQuickAction(resolveQuickAction(branch(), false))).toEqual({
      label: "Push",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    });
  });

  it("leaves the actions the branch can run alone", () => {
    const ahead = resolveQuickAction(branch({ aheadCount: 1, aheadOfDefaultCount: 1 }), false);
    expect(ahead.kind).toBe("run_action");
    expect(ownBranchQuickAction(ahead)).toBe(ahead);
  });
});
