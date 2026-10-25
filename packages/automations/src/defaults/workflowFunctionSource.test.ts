import { describe, expect, it } from "@effect/vitest";

import { workflowFunctionSource } from "./workflowFunctionSource.ts";

describe("workflow function source", () => {
  it("keeps statement locations stable across whitespace and trailing comma changes", () => {
    const source = workflowFunctionSource({
      toString: () => `function proof(input,) {
        const matches = /a;b/.test(input);
        return { matches, };
      }`,
    });
    const transformed = workflowFunctionSource({
      toString: () => "function proof(input){const matches=/a;b/.test(input);return {matches};}",
    });

    expect(transformed).toBe(source);
    expect(source).toContain("/a;b/");
    expect(source).toContain("matches\n  }");
  });
});
