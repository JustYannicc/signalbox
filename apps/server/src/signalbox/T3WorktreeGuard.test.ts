// @effect-diagnostics nodeBuiltinImport:off - fixtures use temp directories from node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { isT3HomeWorktree } from "./T3WorktreeGuard.ts";

describe("T3 worktree guard", () => {
  it("refuses worktrees inside the T3 home and allows everything else", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-guard-"));
    try {
      const t3Worktree = NodePath.join(home, ".t3", "worktrees", "repo", "branch");
      NodeFS.mkdirSync(t3Worktree, { recursive: true });
      const options = { homeDirectory: home, t3HomeOverride: "" };

      assert.isTrue(isT3HomeWorktree(t3Worktree, options));
      assert.isTrue(isT3HomeWorktree(`${t3Worktree}/../branch`, options));
      assert.isFalse(
        isT3HomeWorktree(NodePath.join(home, ".signalbox", "worktrees", "repo", "b"), options),
      );
      assert.isFalse(isT3HomeWorktree(NodePath.join(home, ".t3-other", "x"), options));
      // A server deliberately run on the T3 home owns those worktrees.
      assert.isFalse(
        isT3HomeWorktree(t3Worktree, { homeDirectory: home, t3HomeOverride: `${home}/.t3` }),
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
