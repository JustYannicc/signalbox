import { describe, expect, it } from "vite-plus/test";

import { parseReviewGuidePatch } from "@t3tools/provider-core/server/reviewGuideNormalize";

describe("parseReviewGuidePatch", () => {
  it("reads changed paths and hunk ranges from GitHub's quoted unified patch", () => {
    const change = parseReviewGuidePatch(
      [
        'diff --git "a/src/ old.ts" "b/src/ new.ts"',
        'rename from "src/ old.ts"',
        'rename to "src/ new.ts"',
        '--- "a/src/ old.ts"',
        '+++ "b/src/ new.ts"',
        "@@ -4,2 +4,3 @@",
        " old",
        "+new",
        " tail",
        "diff --git a/src/removed.ts b/src/removed.ts",
        "deleted file mode 100644",
        "--- a/src/removed.ts",
        "+++ /dev/null",
        "@@ -8 +0,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );

    expect(change.files).toEqual(["src/ new.ts", "src/removed.ts"]);
    expect(change.hunks.get("src/ new.ts")).toEqual({
      new: [{ start: 4, end: 6 }],
      old: [{ start: 4, end: 5 }],
    });
    expect(change.hunks.get("src/removed.ts")).toEqual({
      new: [],
      old: [{ start: 8, end: 8 }],
    });
  });
});
