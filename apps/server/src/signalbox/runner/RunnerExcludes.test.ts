import { describe, expect, it } from "@effect/vitest";

import { CACHES_LINE, RESTORED_BLOCK, SHORTCUTS_BLOCK, threadExcludes } from "./RunnerExcludes.ts";

describe("threadExcludes", () => {
  it("keeps the thread's own lines and drops git's comments and the Runner's", () => {
    const text = [
      "# git ls-files --others --exclude-from=.git/info/exclude",
      ".env",
      CACHES_LINE,
      SHORTCUTS_BLOCK.begin,
      "/shared/",
      SHORTCUTS_BLOCK.end,
      "scratch/",
      RESTORED_BLOCK.begin,
      "/notes/plan.md",
      RESTORED_BLOCK.end,
      "",
    ].join("\n");
    expect(threadExcludes(text)).toEqual([".env", "scratch/"]);
  });

  it("never takes one block's end for another's, so a broken block costs no thread lines", () => {
    const text = [
      RESTORED_BLOCK.begin,
      "/a",
      ".env",
      SHORTCUTS_BLOCK.begin,
      "/shared/",
      SHORTCUTS_BLOCK.end,
      "",
    ].join("\n");
    // The restored block never ended: its lines stay, and nothing past it is lost.
    expect(threadExcludes(text)).toEqual(["/a", ".env"]);
  });
});
