import { describe, expect, it } from "vitest";
import { previewFileHeaders, previewFilePath } from "@t3tools/shared/previewFiles";

describe("thread file preview paths", () => {
  it("keeps file names and directory roots", () => {
    expect(previewFilePath("/")).toBe("");
    expect(previewFilePath("/site/")).toBe("site/");
    expect(previewFilePath("/site/caf%C3%A9%20%E4%B8%AD%E6%96%87.html")).toBe(
      "site/café 中文.html",
    );
  });

  it.each([
    "site/index.html",
    "/../secret",
    "/%2e%2e/secret",
    "/.env",
    "/a/.git/config",
    "/%252e%252e/secret",
    "/a%5cb",
    "/a%00b",
    "/bad%",
    "//secret",
    "/a//b",
  ])("refuses %s", (path) => {
    expect(previewFilePath(path)).toBeNull();
  });

  it("serves imported browser assets with their MIME and no cache", () => {
    expect(previewFileHeaders("site/style.css")).toEqual({
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    expect(previewFileHeaders("site/main.mjs")["content-type"]).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(previewFileHeaders("fonts/noto.woff2")["content-type"]).toBe("font/woff2");
    expect(previewFileHeaders("image.unknown")["content-type"]).toBe("application/octet-stream");
  });
});
