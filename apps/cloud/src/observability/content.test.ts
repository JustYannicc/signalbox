import { describe, expect, it } from "@effect/vitest";

import { REDACTED, redactContent } from "./content.ts";

describe("redactContent", () => {
  it("keeps ordinary request paths", () => {
    const event = { path: "/api/auth/session", method: "GET", status: 200 };
    redactContent(event);
    expect(event).toEqual({ path: "/api/auth/session", method: "GET", status: 200 });
  });

  it("drops an undecodable path without losing request status", () => {
    const event: Record<string, unknown> = { path: "/api/%ZZ/hooks/canary", status: 400 };
    redactContent(event);
    expect(event).toEqual({ status: 400, redactionFailed: true });
  });

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

  it.each([
    "code",
    "state",
    "access_token",
    "refresh_token",
    "id_token",
    "token",
    "ticket",
    "api_key",
    "client_secret",
  ])("redacts %s and URL fields before any drain sees them", (key) => {
    const event = {
      action: "request",
      state: "ready",
      code: "redirect",
      request: {
        url: `https://example.com/oauth?${key}=canary-credential`,
        query_string: `${key}=canary-credential`,
        status: 302,
      },
      attributes: {
        "url.full": `https://example.com/?${key}=canary-credential`,
        "url.query": `${key}=canary-credential`,
        "http.url": `https://example.com/?${key}=canary-credential`,
      },
    };
    redactContent(event);
    expect(JSON.stringify(event)).not.toContain("canary");
    expect(event.request.status).toBe(302);
    expect(event.state).toBe("ready");
    expect(event.code).toBe("redirect");
    expect(event.attributes["url.query"]).toBe(REDACTED);
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

  it("keeps bounded turn failure classes for Sentry grouping", () => {
    const event = {
      action: "turn",
      turn: { failureClass: "usage_limit" },
      error: { name: "canary-error-name", message: "canary-rejected-prompt" },
    };
    redactContent(event);
    expect(event.error).toEqual({ name: "TurnFailure.usage_limit", message: REDACTED });
    expect(JSON.stringify(event)).not.toContain("canary");
  });
});
