import { describe, expect, it } from "vite-plus/test";

import { poolLoginCallback } from "./poolLoginCallback.ts";

const state = "active-state";
const redirect = "http://localhost:54545/callback";
const authorization = `https://claude.ai/oauth/authorize?${new URLSearchParams({
  redirect_uri: redirect,
  state,
})}`;
const manualAuthorization = `https://claude.ai/oauth/authorize?${new URLSearchParams({
  redirect_uri: "https://platform.claude.com/oauth/code/callback",
  state,
})}`;

describe("pool login callback input", () => {
  it("accepts Claude's code#state form without treating the state as part of the code", () => {
    expect(poolLoginCallback(authorization, state, "  code_abc#active-state  ")).toBe(
      "http://localhost:54545/callback?code=code_abc&state=active-state",
    );
  });

  it("returns a state-bound manual code without fabricating a callback URL", () => {
    expect(poolLoginCallback(manualAuthorization, state, " code_abc ", "manual")).toEqual({
      state,
      code: "code_abc",
    });
    expect(poolLoginCallback(manualAuthorization, state, `code_abc#${state}`, "manual")).toEqual({
      state,
      code: "code_abc",
    });
    expect(poolLoginCallback(manualAuthorization, state, `code_abc#other-state`, "manual")).toBe(
      null,
    );
  });

  it("requires the exact Claude manual redirect and one matching state", () => {
    expect(poolLoginCallback(authorization, state, "code_abc", "manual")).toBeNull();
    expect(
      poolLoginCallback(
        `${manualAuthorization}&redirect_uri=${encodeURIComponent(redirect)}`,
        state,
        "code_abc",
        "manual",
      ),
    ).toBeNull();
    expect(poolLoginCallback(manualAuthorization, "other-state", "code_abc", "manual")).toBeNull();
  });

  it("preserves matching success and denial callbacks", () => {
    for (const response of [
      "code=code_abc",
      "error=access_denied&error_description=Cancelled",
      "error_description=Cancelled",
    ]) {
      const callback = `${redirect}?state=active-state&${response}`;
      expect(poolLoginCallback(authorization, state, callback)).toBe(callback);
    }
  });

  it.each([
    "code_abc#other-state",
    `${redirect}?code=code_abc&state=other-state`,
    `${redirect}?code=code_abc&state=active-state&state=other-state`,
    `${redirect}?code=code_abc&code=other-code&state=active-state`,
    `${redirect}?code=code_abc&error=access_denied&state=active-state`,
    `${redirect}?state=active-state`,
    "http://localhost:1455/auth/callback?code=code_abc&state=active-state",
    "https://example.test/callback?code=code_abc&state=active-state",
    "",
    "code with whitespace",
  ])("refuses input outside this flow: %s", (input) => {
    expect(poolLoginCallback(authorization, state, input)).toBeNull();
  });
});
