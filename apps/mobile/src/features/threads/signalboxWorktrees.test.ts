import { describe, expect, it } from "vite-plus/test";

import { newThreadWorkspaceMode, offersNewThreadBranch } from "./signalboxWorktrees";

describe("newThreadWorkspaceMode", () => {
  it("keeps the draft's choice, then the default, where worktrees exist", () => {
    expect(
      newThreadWorkspaceMode({ supportsWorktrees: true, chosen: "local", fallback: "worktree" }),
    ).toBe("local");
    expect(
      newThreadWorkspaceMode({ supportsWorktrees: true, chosen: undefined, fallback: "worktree" }),
    ).toBe("worktree");
  });

  it("starts in the checkout without worktrees, even from a saved worktree draft", () => {
    // A pull request's draft asks for a worktree before the environment is known.
    expect(
      newThreadWorkspaceMode({
        supportsWorktrees: false,
        chosen: "worktree",
        fallback: "worktree",
      }),
    ).toBe("local");
  });
});

describe("offersNewThreadBranch", () => {
  const root = "/repo";

  it("offers branches in other worktrees where worktrees exist", () => {
    expect(
      offersNewThreadBranch(
        { worktreePath: "/repo-feature" },
        { supportsWorktrees: true, workspaceRoot: root },
      ),
    ).toBe(true);
  });

  it("offers only branches the checkout can switch to without worktrees", () => {
    const input = { supportsWorktrees: false, workspaceRoot: root };
    expect(offersNewThreadBranch({ worktreePath: null }, input)).toBe(true);
    expect(offersNewThreadBranch({ worktreePath: root }, input)).toBe(true);
    expect(offersNewThreadBranch({ worktreePath: "/repo-feature" }, input)).toBe(false);
  });
});
