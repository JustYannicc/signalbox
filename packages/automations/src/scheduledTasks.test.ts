import { describe, expect, it } from "@effect/vitest";

import {
  intervalCron,
  readScheduledTask,
  scheduledTaskSource,
  scheduledTaskTrigger,
  type ScheduledTaskSpec,
} from "./scheduledTasks.ts";

const spec = (overrides: Partial<ScheduledTaskSpec> = {}): ScheduledTaskSpec => ({
  title: "Post the time",
  prompt: "Post the current time.",
  schedule: { type: "interval", everyMs: 5 * 60_000 },
  timezone: "Europe/Zurich",
  threadId: "thread-1",
  key: null,
  ...overrides,
});

describe("intervalCron", () => {
  it("runs intervals that divide an hour or a day on the clock", () => {
    expect(intervalCron(60_000)).toEqual({ cron: "* * * * *", everyMs: 60_000 });
    expect(intervalCron(5 * 60_000)).toEqual({ cron: "*/5 * * * *", everyMs: 300_000 });
    expect(intervalCron(60 * 60_000)).toEqual({ cron: "0 * * * *", everyMs: 3_600_000 });
    expect(intervalCron(6 * 3_600_000)).toEqual({ cron: "0 */6 * * *", everyMs: 21_600_000 });
    expect(intervalCron(86_400_000)).toEqual({ cron: "0 0 * * *", everyMs: 86_400_000 });
    expect(intervalCron(7 * 86_400_000)).toEqual({ cron: "0 0 * * 0", everyMs: 604_800_000 });
  });

  it("snaps intervals a cron can't keep to the nearest one it can", () => {
    expect(intervalCron(7 * 60_000)).toEqual({ cron: "*/6 * * * *", everyMs: 360_000 });
    expect(intervalCron(90 * 60_000)).toEqual({ cron: "0 */2 * * *", everyMs: 7_200_000 });
    expect(intervalCron(5 * 3_600_000)).toEqual({ cron: "0 */6 * * *", everyMs: 21_600_000 });
    expect(intervalCron(3 * 86_400_000)).toEqual({ cron: "0 0 * * 0", everyMs: 604_800_000 });
  });
});

describe("scheduledTaskTrigger", () => {
  it("makes a cron in the task's timezone from a fixed time", () => {
    expect(
      scheduledTaskTrigger(
        { type: "fixed_time", timeOfDay: "9:05", weekdays: [5, 1, 1] },
        "Europe/Zurich",
      ),
    ).toEqual({ cron: "5 9 * * 1,5", timezone: "Europe/Zurich" });
    expect(
      scheduledTaskTrigger({ type: "fixed_time", timeOfDay: "18:30", weekdays: [] }, "UTC"),
    ).toEqual({ cron: "30 18 * * *", timezone: "UTC" });
  });
});

describe("scheduledTaskSource", () => {
  it("wakes the bound thread on every run", () => {
    const source = scheduledTaskSource(spec());
    expect(source).toContain(`triggers: [{"cron":"*/5 * * * *","timezone":"Europe/Zurich"}]`);
    expect(source).toContain(`"signalbox.t3_thread_send"`);
    expect(source).toContain(`threadId: "thread-1"`);
    expect(source).not.toContain("w.agent(");
  });

  it("starts an agent in a fresh thread when unbound", () => {
    const source = scheduledTaskSource(spec({ threadId: null }));
    expect(source).toContain(`w.agent("Run the prompt"`);
    expect(source).not.toContain("t3_thread_send");
  });

  it("escapes prompts and titles into the file", () => {
    const tricky = spec({
      title: 'Say "hi"',
      prompt: "Line one\n`${process.exit()}` */ end   after",
    });
    expect(readScheduledTask(scheduledTaskSource(tricky))).toEqual(tricky);
  });
});

describe("readScheduledTask", () => {
  it("reads back what it wrote, with the interval it really runs", () => {
    const written = spec({ schedule: { type: "interval", everyMs: 7 * 60_000 }, key: "req-1" });
    expect(readScheduledTask(scheduledTaskSource(written))).toEqual({
      ...written,
      schedule: { type: "interval", everyMs: 360_000 },
    });
  });

  it("lets an automation someone changed go", () => {
    const source = scheduledTaskSource(spec());
    expect(readScheduledTask(source.replace("Post the current time.", "Post the date."))).toBe(
      null,
    );
    expect(readScheduledTask("export const meta = { name: 'x' } as const;")).toBe(null);
  });
});
