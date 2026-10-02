import { describe, expect, it } from "vite-plus/test";

import { appForwardUrl } from "./appForward";

const returnUrl = encodeURIComponent("signalbox://app/account-return");

describe("appForwardUrl", () => {
  it("forwards a handoff to the app's deep link", () => {
    expect(appForwardUrl(`?returnUrl=${returnUrl}&handoff=h_1`)).toEqual({
      _tag: "handoff",
      url: "signalbox://app/account-return?handoff=h_1",
    });
  });

  it("forwards errors, normalizing unknown codes to failed", () => {
    expect(appForwardUrl(`?returnUrl=${returnUrl}&error=cancelled&email=a%40b.co`)).toEqual({
      _tag: "error",
      url: "signalbox://app/account-return?error=cancelled",
      error: "cancelled",
    });
    expect(appForwardUrl(`?returnUrl=${returnUrl}&error=weird`)).toMatchObject({
      error: "failed",
    });
  });

  it("keeps dev and preview builds' schemes", () => {
    expect(
      appForwardUrl(
        `?returnUrl=${encodeURIComponent("signalbox-dev://app/account-return")}&handoff=h`,
      )?.url,
    ).toBe("signalbox-dev://app/account-return?handoff=h");
  });

  it("ignores ordinary visits and anything that isn't a Signalbox app link", () => {
    for (const search of [
      "",
      "?handoff=h",
      "?error=cancelled",
      `?returnUrl=${returnUrl}`,
      `?returnUrl=${encodeURIComponent("https://evil.example/x")}&handoff=h`,
      `?returnUrl=${encodeURIComponent("javascript:alert(1)")}&handoff=h`,
      `?returnUrl=${encodeURIComponent("signalbox://u:p@app/account-return")}&handoff=h`,
      "?returnUrl=not%20a%20url&handoff=h",
    ]) {
      expect(appForwardUrl(search)).toBeNull();
    }
  });
});
