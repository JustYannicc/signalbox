import { describe, expect, it } from "vite-plus/test";

import { isGuideDiffRevisionCurrent } from "./useGuideDiffFiles";

describe("isGuideDiffRevisionCurrent", () => {
  it("accepts the guide head and rejects a moved diff head", () => {
    const guideHeadSha = "a".repeat(40);

    expect(
      isGuideDiffRevisionCurrent(guideHeadSha, {
        baseSha: "b".repeat(40),
        headSha: guideHeadSha,
      }),
    ).toBe(true);
    expect(
      isGuideDiffRevisionCurrent(guideHeadSha, {
        baseSha: "b".repeat(40),
        headSha: "c".repeat(40),
      }),
    ).toBe(false);
  });

  it("keeps revision-less self-host diffs compatible", () => {
    expect(isGuideDiffRevisionCurrent("guide-head", undefined)).toBe(true);
  });
});
