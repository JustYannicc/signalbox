import { describe, expect, it } from "vite-plus/test";

import { isSignInHandBack } from "./signalboxPoolSignIn.ts";

describe("isSignInHandBack", () => {
  it.each([
    ["Anthropic's code#state", "aBc-123_x.y~z#St4te-9"],
    ["the localhost address", "http://localhost:54545/callback?code=abc&state=xyz"],
    ["Anthropic's code page address", "https://platform.claude.com/oauth/code/callback?code=abc"],
  ])("takes %s", (_, text) => expect(isSignInHandBack(text)).toBe(true));

  it.each([
    ["a bare code still being typed", "abc123"],
    ["text with spaces", "abc #def"],
    ["an address without a code", "http://localhost:54545/callback?state=xyz"],
    ["an empty paste", ""],
  ])("waits on %s", (_, text) => expect(isSignInHandBack(text)).toBe(false));
});
