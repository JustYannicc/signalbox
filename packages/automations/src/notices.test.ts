import { describe, expect, it } from "@effect/vitest";

import { automationNotice } from "./notices.ts";

describe("automation ask notices", () => {
  it("keeps the ask priority in its notice", () => {
    const notice = automationNotice({
      automation: { automation_id: "automation-1", name: "Settle task" },
      step: {
        run_id: "run-1",
        step_key: "ask",
        verb: "ask",
        label: "Why did you settle this task?",
        args_json: JSON.stringify([
          {
            question: "Which reason fits?",
            options: ["dropped", "done-enough"],
            importance: "low",
          },
        ]),
      },
      at: "2026-10-17T10:00:00.000Z",
    });

    expect(notice).toMatchObject({ kind: "ask", importance: "low" });
  });
});
