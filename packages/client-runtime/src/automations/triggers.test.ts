import { describe, expect, it } from "vite-plus/test";

import { describeTrigger, startsFromPayloadOnly, triggerSummary } from "./triggers.ts";

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
