import { describe, expect, it } from "@effect/vitest";

import { REDACTED, redactContent } from "./content.ts";

describe("redactContent", () => {
  it("replaces text under content-shaped keys at any depth and keeps their numbers", () => {
    const event = {
      action: "turn",
      prompt: "Summarize the board minutes",
      turn: {
        id: "run-1",
        modelTokens: { input: 1200, output: 340 },
        tool: { arguments: { path: "/notes.md", lines: 3 }, output: ["a", "b"] },
      },
      requestLogs: [{ level: "info", message: "turn closed", body: "hello" }],
    };
    redactContent(event);
    expect(event).toEqual({
      action: "turn",
      prompt: REDACTED,
      turn: {
        id: "run-1",
        modelTokens: { input: 1200, output: 340 },
        tool: { arguments: { path: REDACTED, lines: 3 }, output: [REDACTED, REDACTED] },
      },
      requestLogs: [{ level: "info", message: "turn closed", body: REDACTED }],
    });
  });

  it("handles cycles", () => {
    const turn: Record<string, unknown> = { id: "run-1", text: "a reply" };
    turn.self = turn;
    const event = { action: "turn", turn };
    redactContent(event);
    expect(turn.text).toBe(REDACTED);
    expect(turn.self).toBe(turn);
  });
});
