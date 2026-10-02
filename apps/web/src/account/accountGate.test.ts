import type { AccountSessionState } from "@t3tools/contracts/account";
import { describe, expect, it } from "vite-plus/test";

import { decideAccountGate, sanitizeReturnTo } from "./accountGate";

const signedOut: AccountSessionState = {
  enabled: true,
  providers: ["google", "github", "apple", "email"],
  account: null,
};
const signedIn: AccountSessionState = {
  ...signedOut,
  account: { id: "user_1", email: "a@b.co" },
};
const disabled: AccountSessionState = {
  enabled: false,
  providers: [],
  account: null,
};

const at = (href: string, session: AccountSessionState | null) =>
  decideAccountGate({ pathname: href.split(/[?#]/u)[0]!, href, session });

describe("decideAccountGate", () => {
  it("sends every app route to sign-in while accounts are on and nobody is signed in", () => {
    expect(at("/", signedOut)).toEqual({ _tag: "sign-in" });
    expect(at("/pair#token=spent", signedOut)).toEqual({ _tag: "sign-in" });
    expect(at("/settings/general?machine=x", signedOut)).toEqual({
      _tag: "sign-in",
      returnTo: "/settings/general?machine=x",
    });
  });

  it("keeps the sign-in page open while accounts are on, and only then", () => {
    expect(at("/sign-in?error=cancelled", signedOut)).toEqual({ _tag: "allow" });
    // Desktop finishes sign-in here in a browser that may already be signed in.
    expect(at("/sign-in?returnUrl=signalbox%3A%2F%2Fapp&handoff=h", signedIn)).toEqual({
      _tag: "allow",
    });
    expect(at("/sign-in", disabled)).toEqual({ _tag: "leave-sign-in" });
    expect(at("/sign-in", null)).toEqual({ _tag: "leave-sign-in" });
  });

  it("changes nothing when accounts are off, unknown, or already satisfied", () => {
    for (const session of [disabled, null, signedIn]) {
      expect(at("/", session)).toEqual({ _tag: "allow" });
      expect(at("/pair", session)).toEqual({ _tag: "allow" });
    }
  });

  it("leaves the T3 Connect CLI authorization route alone", () => {
    expect(at("/connect", signedOut)).toEqual({ _tag: "allow" });
  });
});

describe("sanitizeReturnTo", () => {
  it("keeps same-origin app paths", () => {
    expect(sanitizeReturnTo("/settings/general?x=1#a")).toBe("/settings/general?x=1#a");
  });

  it("drops anything that could leave the app or loop back to sign-in", () => {
    for (const value of [
      undefined,
      "",
      "settings",
      "https://evil.example/",
      "//evil.example",
      "/\\evil.example",
      "/sign-in",
      "/sign-in?selectAccount=1",
    ]) {
      expect(sanitizeReturnTo(value)).toBeUndefined();
    }
  });
});
