import { describe, expect, it } from "@effect/vitest";

import {
  feedIndexForFindTarget,
  formatThreadFindCount,
  threadFindRevealAction,
} from "./thread-find-model";

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

  it("does not treat a collapsed run fold as the matched entry", () => {
    expect(feedIndexForFindTarget(rows, { entryId: "hidden", runId: "run-3" })).toBe(-1);
  });

  it("reports a match the feed hasn't rendered yet", () => {
    expect(feedIndexForFindTarget(rows, { entryId: "hidden", runId: "run-9" })).toBe(-1);
    expect(feedIndexForFindTarget(rows, { entryId: "hidden", runId: null })).toBe(-1);
  });
});

describe("threadFindRevealAction", () => {
  const target = { entryId: "tool-7", runId: "run-3" };
  const sourceFeed = [
    {
      type: "activity-group",
      activities: [
        {
          id: "private:thread:tool-7",
          prominent: false,
          projectedItem: { item: { id: "tool-7", type: "command_execution" } },
        },
      ],
    },
  ];

  it("opens the tool details before scrolling to a match inside them", () => {
    const visible = [
      {
        id: "work-details:group-1",
        type: "activity-group",
        activities: [{ id: "activity-7", projectedItem: { item: { id: "tool-7" } } }],
      },
    ];
    expect(threadFindRevealAction(visible, sourceFeed, target)).toEqual({
      type: "expand-work-row",
      rowId: "activity-7",
      anchorKey: "work-details:group-1",
    });
    expect(threadFindRevealAction(visible, sourceFeed, target, { "activity-7": true })).toEqual({
      type: "scroll",
      index: 0,
    });
  });

  it("expands the matching run, then its work group, and scrolls only to the exposed match", () => {
    expect(
      threadFindRevealAction(
        [{ id: "run-fold:run-3", type: "run-fold", runId: "run-3", expanded: false }],
        sourceFeed,
        target,
      ),
    ).toEqual({ type: "expand-run", runId: "run-3" });

    expect(
      threadFindRevealAction(
        [
          { id: "run-fold:run-3", type: "run-fold", runId: "run-3", expanded: true },
          {
            id: "work-toggle:work-group:private:thread:tool-7",
            type: "work-toggle",
            runId: "run-3",
            groupId: "work-group:private:thread:tool-7",
            expanded: false,
          },
        ],
        sourceFeed,
        target,
      ),
    ).toEqual({
      type: "expand-work-group",
      groupId: "work-group:private:thread:tool-7",
      anchorKey: "work-toggle:work-group:private:thread:tool-7",
    });

    expect(
      threadFindRevealAction(
        [
          { id: "run-fold:run-3", type: "run-fold", runId: "run-3", expanded: true },
          {
            id: "work-toggle:work-group:private:thread:tool-7",
            type: "work-toggle",
            runId: "run-3",
            groupId: "work-group:private:thread:tool-7",
            expanded: true,
          },
          {
            id: "work-details:work-group:private:thread:tool-7",
            type: "activity-group",
            activities: [{ projectedItem: { item: { id: "tool-7" } } }],
          },
        ],
        sourceFeed,
        target,
      ),
    ).toEqual({ type: "scroll", index: 2 });
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
