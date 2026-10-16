import { describe, expect, it } from "@effect/vitest";
import { scheduledTaskSource, type ScheduledTaskSpec } from "@signalbox/automations/scheduledTasks";

import { compileWorkflow } from "./compiler/compileWorkflow.ts";

const base: ScheduledTaskSpec = {
  title: "Post the time",
  prompt: "Post the current time.",
  schedule: { type: "interval", everyMs: 5 * 60_000 },
  timezone: "UTC",
  threadId: "thread-1",
  key: null,
};

describe("scheduled task files", () => {
  it.each([
    ["an interval waking a thread", base],
    [
      "a fixed time starting an agent",
      {
        ...base,
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
        timezone: "Europe/Zurich",
        threadId: null,
      },
    ],
  ] satisfies ReadonlyArray<[string, ScheduledTaskSpec]>)("compile: %s", (_name, spec) => {
    const compiled = compileWorkflow(scheduledTaskSource(spec));
    expect(compiled.ok ? [] : compiled.diagnostics).toEqual([]);
    if (!compiled.ok) return;
    expect(compiled.workflow.meta.name).toBe("Post the time");
    expect(compiled.workflow.graph.nodes.some((node) => node.type === "step")).toBe(true);
  });
});
