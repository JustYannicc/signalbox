import { describe, expect, it } from "@effect/vitest";

import { containerCapacity } from "./containerCapacity.ts";

const application = (name: string, max: number, active: number, assigned: number) => ({
  name,
  max_instances: max,
  health: { instances: { active, assigned, healthy: 7 } },
});

describe("containerCapacity", () => {
  it("counts instances bound to an object, not prewarmed ones", () => {
    expect(containerCapacity([application("pools", 100, 3, 2)], ["pools"])).toEqual([
      { name: "pools", inUse: 5, max: 100, nearCap: false },
    ]);
  });

  it("is near the cap from 80% of it", () => {
    const rows = containerCapacity(
      [application("pools", 100, 79, 0), application("threads", 200, 150, 10)],
      ["pools", "threads"],
    );
    expect(rows.map((row) => row.nearCap)).toEqual([false, true]);
  });

  it("refuses to report when a watched application is gone", () => {
    expect(() => containerCapacity([application("other", 10, 0, 0)], ["pools"])).toThrow(
      /No container application named "pools"/,
    );
  });
});
