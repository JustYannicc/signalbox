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
      requestLogs: [{ level: "info", message: REDACTED, body: REDACTED }],
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

  it.each([false, true])("redacts aliases regardless of traversal order (%s)", (contentFirst) => {
    const shared = { nested: ["canary-private-payload"], count: 3 };
    const event = contentFirst
      ? { payload: shared, metadata: shared }
      : { metadata: shared, payload: shared };
    redactContent(event);
    expect(event.metadata.nested).toEqual([REDACTED]);
    expect(event.payload.count).toBe(3);
    expect(JSON.stringify(event)).not.toContain("canary-private-payload");
  });

  it("redacts a cycle reached later through a content key", () => {
    const event: Record<string, unknown> = { note: "canary-private-cycle" };
    event.payload = event;
    redactContent(event);
    expect(event.note).toBe(REDACTED);
  });
});
