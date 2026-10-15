import { describe, expect, it } from "vite-plus/test";

import {
  describeTrigger,
  startsFromPayloadOnly,
  triggerSummary,
  watchedSource,
} from "./triggers.ts";

describe("describeTrigger", () => {
  it("says common schedules in words", () => {
    expect(describeTrigger({ cron: "0 * * * *" })).toBe("Every hour");
    expect(describeTrigger({ cron: "30 9 * * 1-5" })).toBe("Weekdays at 9:30");
    expect(describeTrigger({ cron: "0 8 * * 1" })).toBe("Mondays at 8:00");
    expect(describeTrigger({ webhook: true })).toBe("When a webhook arrives");
    expect(triggerSummary([])).toBe("When you run it");
  });

  it("says event triggers in words", () => {
    expect(describeTrigger({ on: "turn.finished" })).toBe("When a turn finishes");
    const watch = { operation: "github.actions.listWorkflowRunsForRepo", key: "id" };
    expect(describeTrigger({ on: "source.item.added", watch })).toBe(
      "When something new shows up in Github workflow runs for repo",
    );
    expect(describeTrigger({ on: "source.item.*", watch })).toBe(
      "When anything changes in Github workflow runs for repo",
    );
    expect(describeTrigger({ on: "message.sent" })).toBe("When you send a message");
    expect(describeTrigger({ on: "message.sent", from: "anyone" })).toBe("When a message is sent");
    expect(describeTrigger({ on: ["thread.created", "input.requested"] })).toBe(
      "When you start a thread or an agent needs you",
    );
    expect(
      describeTrigger({
        on: "turn.finished",
        scope: "all",
        where: { status: ["failed", "cancelled"] },
      }),
    ).toBe("When a turn finishes in any project, if status is failed or cancelled");
    expect(describeTrigger({ on: "orchestration.node.updated" })).toBe(
      "On orchestration.node.updated",
    );
  });

  it("knows when only a payload starts it", () => {
    expect(startsFromPayloadOnly({ triggers: [{ webhook: true }, { on: "turn.finished" }] })).toBe(
      true,
    );
    expect(startsFromPayloadOnly({ triggers: [{ webhook: true }, { cron: "0 * * * *" }] })).toBe(
      false,
    );
    expect(startsFromPayloadOnly({ triggers: [] })).toBe(false);
  });
});

describe("watchedSource", () => {
  const now = Date.parse("2026-10-15T10:00:00.000Z");
  const source = {
    sourceId: "source_1",
    operation: "github.actions.listWorkflowRunsForRepo",
    connection: null,
    status: "watching" as const,
    lastCheckedAt: "2026-10-15T09:58:00.000Z",
    lastChangedAt: null,
    nextCheckAt: "2026-10-15T10:03:00.000Z",
    error: null,
  };
  it("says what's watched and how reading it goes", () => {
    expect(watchedSource(source, now)).toEqual({
      subject: "Github workflow runs for repo",
      status: "checked 2m ago",
      trouble: false,
    });
    expect(watchedSource({ ...source, status: "failing", connection: "work" }, now)).toEqual({
      subject: "Github workflow runs for repo (work)",
      status: "couldn't read it, trying again in 3m",
      trouble: true,
    });
    expect(watchedSource({ ...source, status: "starting", lastCheckedAt: null }, now).status).toBe(
      "first check soon",
    );
  });
});
