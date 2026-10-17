import { describe, expect, it } from "@effect/vitest";

import { feedIndexForFindTarget, formatThreadFindCount } from "./thread-find-model";

const rows = [
  { id: "message-1", type: "message", message: { projectedItem: { item: { id: "item-1" } } } },
  {
    id: "work-details:group",
    type: "activity-group",
    activities: [{ projectedItem: { item: { id: "plan-7" } } }],
  },
  { id: "run-fold:run-3", type: "run-fold" },
];

describe("feedIndexForFindTarget", () => {
  it("finds a message by its entry id", () => {
    expect(feedIndexForFindTarget(rows, { entryId: "message-1", runId: null })).toBe(0);
  });

  it("finds a turn item inside a grouped row", () => {
    expect(feedIndexForFindTarget(rows, { entryId: "plan-7", runId: null })).toBe(1);
  });

  it("falls back to the collapsed run that holds the match", () => {
    expect(feedIndexForFindTarget(rows, { entryId: "hidden", runId: "run-3" })).toBe(2);
  });

  it("reports a match the feed hasn't rendered yet", () => {
    expect(feedIndexForFindTarget(rows, { entryId: "hidden", runId: "run-9" })).toBe(-1);
    expect(feedIndexForFindTarget(rows, { entryId: "hidden", runId: null })).toBe(-1);
  });
});

describe("formatThreadFindCount", () => {
  it("shows position, totals still counting, and no matches", () => {
    expect(formatThreadFindCount(1, 4, false)).toBe("2/4");
    expect(formatThreadFindCount(9, 4, false)).toBe("4/4");
    expect(formatThreadFindCount(0, 3, true)).toBe("1/3+");
    expect(formatThreadFindCount(0, 0, true)).toBe("…");
    expect(formatThreadFindCount(0, 0, false)).toBe("0/0");
  });
});
