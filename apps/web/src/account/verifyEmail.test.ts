import { describe, expect, it } from "vite-plus/test";

import {
  classifyVerifyResponse,
  normalizeCode,
  parseVerifyRequest,
  safeNextUrl,
} from "./verifyEmail";

const origin = "http://127.0.0.1:3773";

describe("parseVerifyRequest", () => {
  it("reads the attempt id and the address the code went to", () => {
    expect(parseVerifyRequest("?verify=v_1&email=a%40b.co")).toEqual({
      verify: "v_1",
      email: "a@b.co",
    });
    expect(parseVerifyRequest("?verify=v_1")).toEqual({ verify: "v_1" });
    expect(parseVerifyRequest("?error=cancelled")).toBeNull();
  });
});

describe("normalizeCode", () => {
  it("drops the spaces and dashes people paste", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
  });
});

describe("safeNextUrl", () => {
  it("follows same-origin paths, this origin, and app deep links", () => {
    expect(safeNextUrl("/", origin)).toBe("/");
    expect(safeNextUrl("/sign-in?handoff=h&returnUrl=x", origin)).toBe(
      "/sign-in?handoff=h&returnUrl=x",
    );
    expect(safeNextUrl(`${origin}/settings`, origin)).toBe(`${origin}/settings`);
    expect(safeNextUrl("signalbox://account-return?handoff=h", origin)).toBe(
      "signalbox://account-return?handoff=h",
    );
  });

  it("refuses other sites and script URLs", () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "nope",
    ]) {
      expect(safeNextUrl(next, origin)).toBeNull();
    }
  });
});

describe("classifyVerifyResponse", () => {
  it("returns where to go next on success", () => {
    expect(classifyVerifyResponse(true, { next: "/" }, origin)).toEqual({
      _tag: "next",
      next: "/",
    });
  });

  it("maps the server's failure codes and treats anything else as failed", () => {
    expect(classifyVerifyResponse(false, { error: "invalid-code" }, origin)).toEqual({
      _tag: "error",
      error: "invalid-code",
    });
    expect(classifyVerifyResponse(false, { error: "expired" }, origin)).toMatchObject({
      error: "expired",
    });
    expect(classifyVerifyResponse(false, null, origin)).toMatchObject({ error: "failed" });
    expect(classifyVerifyResponse(true, { next: "https://evil.example" }, origin)).toMatchObject({
      error: "failed",
    });
  });
});
