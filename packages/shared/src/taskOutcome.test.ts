import { describe, expect, it } from "vite-plus/test";

import { parseTaskOutcome } from "./taskOutcome.ts";

describe("parseTaskOutcome", () => {
  it("keeps plain outcomes verbatim", () => {
    expect(parseTaskOutcome("Merged and deployed")).toEqual(["Merged and deployed"]);
    expect(parseTaskOutcome("")).toEqual([]);
  });

  it("turns a safe link into a link part with surrounding text", () => {
    expect(
      parseTaskOutcome("[Live at abc123](https://github.com/o/r/actions/runs/123) after smoke"),
    ).toEqual([
      { label: "Live at abc123", url: "https://github.com/o/r/actions/runs/123" },
      " after smoke",
    ]);
  });

  it("parses multiple links in order", () => {
    expect(
      parseTaskOutcome("See [run](https://a.example/1) and [PR](http://b.example/2)."),
    ).toEqual([
      "See ",
      { label: "run", url: "https://a.example/1" },
      " and ",
      { label: "PR", url: "http://b.example/2" },
      ".",
    ]);
  });

  it("keeps only the label for unsafe or unparseable URLs", () => {
    expect(parseTaskOutcome("[x](javascript:alert(1))")).toEqual(["[x](javascript:alert(1))"]);
    expect(parseTaskOutcome("[click](javascript:void0) now")).toEqual(["click", " now"]);
    expect(parseTaskOutcome("[data](data:text/html,hi)")).toEqual(["data"]);
    expect(parseTaskOutcome("[rel](/actions/runs/1)")).toEqual(["rel"]);
  });

  it("leaves malformed Markdown as text", () => {
    expect(parseTaskOutcome("[unclosed](https://a.example")).toEqual([
      "[unclosed](https://a.example",
    ]);
    expect(parseTaskOutcome("[](https://a.example)")).toEqual(["[](https://a.example)"]);
  });
});
