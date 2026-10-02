import { describe, expect, it } from "vite-plus/test";

import { accountReturnLoadUrl } from "./DesktopAccountReturn.ts";

describe("accountReturnLoadUrl", () => {
  it("maps a handoff deep link onto the hash-routed sign-in screen", () => {
    expect(accountReturnLoadUrl("signalbox://app/account-return?handoff=h_123", false)).toBe(
      "signalbox://app/#/sign-in?handoff=h_123",
    );
  });

  it("forwards callback errors and drops unknown parameters", () => {
    expect(
      accountReturnLoadUrl(
        "signalbox-dev://app/account-return?error=cancelled&email=a%40b.co&code=leak",
        true,
      ),
    ).toBe("signalbox-dev://app/#/sign-in?error=cancelled");
  });

  it("rejects links that are not this build's account return", () => {
    for (const link of [
      "signalbox-dev://app/account-return?handoff=h",
      "signalbox://evil/account-return?handoff=h",
      "signalbox://app/settings?handoff=h",
      "signalbox://app/auth/callback?code=clerk",
      "signalbox://user:pw@app/account-return?handoff=h",
      "signalbox://app/account-return",
      "signalbox://app/account-return?handoff=a&handoff=b",
      "https://app/account-return?handoff=h",
      "not a url",
      undefined,
    ]) {
      expect(accountReturnLoadUrl(link, false)).toBeUndefined();
    }
  });
});
