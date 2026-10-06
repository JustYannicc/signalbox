import { describe, expect, it } from "vite-plus/test";

import { modelPrompt, modelResult } from "./modelSteps.ts";

const judge = { input: "Login crashes on Safari", outcomes: ["bug", "question", "spam"] };

describe("model steps", () => {
  it("asks a judge for exactly one outcome", () => {
    const prompt = modelPrompt("judge", "Real bug?", judge);
    expect(prompt).toContain("Real bug?");
    expect(prompt).toContain("Login crashes on Safari");
    expect(prompt).toContain("bug, question, spam");
  });

  it.each([
    ["bug", "bug"],
    ["  **Bug**.", "bug"],
    ["`question`", "question"],
    ["It's clearly a bug report.", "bug"],
  ])("reads the judge answer %j as %j", (text, outcome) => {
    expect(modelResult("judge", judge, text)).toEqual({ ok: true, value: outcome });
  });

  it("fails a judge answer that names none or several outcomes", () => {
    expect(modelResult("judge", judge, "No idea").ok).toBe(false);
    expect(modelResult("judge", judge, "a bug or maybe spam").ok).toBe(false);
  });

  it("reads extracted JSON, with or without a code fence", () => {
    expect(modelResult("extract", {}, '{"total": 42}')).toEqual({ ok: true, value: { total: 42 } });
    expect(modelResult("extract", {}, '```json\n{"total": 42}\n```')).toEqual({
      ok: true,
      value: { total: 42 },
    });
    expect(modelResult("extract", {}, "The total is 42").ok).toBe(false);
  });

  it("returns llm text trimmed", () => {
    expect(modelResult("llm", {}, "  Hello there.\n")).toEqual({ ok: true, value: "Hello there." });
  });
});
