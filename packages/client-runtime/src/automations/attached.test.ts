import { describe, expect, it } from "vite-plus/test";

import { attachedAutomationTasks, attachedRunOf } from "./attached.ts";

describe("attached automation runs", () => {
  it("reads the run and automation out of an attached task, and nothing out of others", () => {
    expect(attachedRunOf("automation-run:automation_1:run_2")).toEqual({
      automationId: "automation_1",
      runId: "run_2",
    });
    expect(attachedRunOf("pull-request-watch:github.com/acme/app#7")).toBeNull();
    expect(attachedRunOf("automation-run:broken")).toBeNull();
    expect(
      attachedAutomationTasks([
        { taskId: "automation-run:automation_1:run_2" },
        { taskId: "subagent:1" },
      ]),
    ).toEqual([{ taskId: "automation-run:automation_1:run_2" }]);
  });
});
