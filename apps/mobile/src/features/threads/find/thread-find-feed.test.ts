import {
  PlanId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, deriveThreadFeedPresentation } from "../../../lib/threadActivity";
import { threadFindRevealAction } from "./thread-find-model";

const at = "2026-06-20T00:00:02.000Z";
const timestamp = DateTime.makeUnsafe(at);
const runId = RunId.make("run-find");
const threadId = ThreadId.make("thread-find");
const latestRun = { runId, status: "completed" as const, startedAt: at, completedAt: at };
const base = {
  id: TurnItemId.make("canonical-item"),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: timestamp,
  completedAt: timestamp,
  updatedAt: timestamp,
};

function projection(item: OrchestrationV2TurnItem, position = 0): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility: "inherited",
    sourceThreadId: ThreadId.make("source-thread"),
    sourceItemId: item.id,
    item,
  };
}

describe("Find targets through native feed conversion", () => {
  it.each([
    {
      toolName: "mcp__t3-code__html_render",
      output: { htmlRender: { attachmentId: "page", title: "Revenue", height: 320 } },
    },
    {
      toolName: "weather.get_weather",
      output: {
        t3McpApp: {
          attachmentId: "weather-app",
          server: "weather",
          tool: "get_weather",
          resourceUri: "ui://weather/dashboard",
        },
        result: { content: [] },
      },
    },
  ])("reaches the completed $toolName item by its canonical id", (tool) => {
    const feed = buildThreadFeed([
      projection({ ...base, type: "dynamic_tool", input: {}, ...tool }),
    ]);
    const presented = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(threadFindRevealAction(presented, feed, { entryId: base.id, runId })).toEqual({
      type: "scroll",
      index: 0,
    });
  });

  it.each([false, true])(
    "reveals task-list text through existing disclosures, explanation only: %s",
    (explanationOnly) => {
      const feed = buildThreadFeed([
        projection({
          ...base,
          type: "todo_list",
          planId: PlanId.make("find-plan"),
          explanation: "Résumé review",
          steps: explanationOnly
            ? []
            : [{ id: "step-one", text: "Check the café plan", status: "running" }],
        }),
      ]);
      const target = { entryId: base.id, runId };
      const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
      expect(threadFindRevealAction(collapsed, feed, target)).toEqual({
        type: "expand-run",
        runId,
      });

      const expandedRun = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
      const groupAction = threadFindRevealAction(expandedRun, feed, target);
      expect(groupAction.type).toBe("expand-work-group");
      if (groupAction.type !== "expand-work-group") throw new Error("Missing task-list disclosure");
      const expandedGroup = deriveThreadFeedPresentation(
        feed,
        latestRun,
        new Set([runId]),
        new Set([groupAction.groupId]),
      );
      const rowAction = threadFindRevealAction(expandedGroup, feed, target);
      expect(rowAction.type).toBe("expand-work-row");
      if (rowAction.type !== "expand-work-row") throw new Error("Missing task-list details");
      const action = threadFindRevealAction(expandedGroup, feed, target, {
        [rowAction.rowId]: true,
      });
      expect(action.type).toBe("scroll-work-row");
      if (action.type !== "scroll-work-row") throw new Error("Missing inner task-list target");
      const row = expandedGroup[action.index];
      expect(row?.type).toBe("activity-group");
      if (row?.type !== "activity-group") throw new Error("Missing task-list row");
      const activity = row.activities[0];
      expect(activity?.canExpand).toBe(true);
      expect(activity?.getFullDetail()).toBe(
        explanationOnly ? "Résumé review" : "Résumé review\nCheck the café plan (running)",
      );
    },
  );

  it.each([false, true])(
    "reveals a runless task list after many activities, synthetic fold: %s",
    (withPrompt) => {
      const commands: OrchestrationV2TurnItem[] = Array.from({ length: 24 }, (_, index) => ({
        ...base,
        id: TurnItemId.make(`command-${index}`),
        ordinal: index + 1,
        runId: null,
        type: "command_execution",
        input: `check-${index}`,
        output: "checked",
      }));
      const todo: OrchestrationV2TurnItem = {
        ...base,
        ordinal: 25,
        runId: null,
        type: "todo_list",
        planId: PlanId.make("runless-plan"),
        steps: [
          { id: "last-step", text: "The target after twenty-four commands", status: "pending" },
        ],
      };
      const prompt: OrchestrationV2TurnItem = {
        ...base,
        id: TurnItemId.make("prompt-item"),
        runId: null,
        type: "user_message",
        messageId: MessageId.make("runless-prompt"),
        createdBy: "user",
        creationSource: "mobile",
        inputIntent: "turn_start",
        text: "Check the plan",
        attachments: [],
      };
      const feed = buildThreadFeed(
        [...(withPrompt ? [prompt] : []), ...commands, todo].map(projection),
      );
      const target = { entryId: todo.id, runId: null };
      const expandedRuns = new Set<RunId>();
      const collapsed = deriveThreadFeedPresentation(feed, null, expandedRuns);
      if (withPrompt) {
        const action = threadFindRevealAction(collapsed, feed, target);
        expect(action).toEqual({ type: "expand-run", runId: "runless:runless-prompt" });
        if (action.type !== "expand-run") throw new Error("Missing owning synthetic fold");
        expandedRuns.add(RunId.make(action.runId));
      }
      const expandedRun = deriveThreadFeedPresentation(feed, null, expandedRuns);
      const group = threadFindRevealAction(expandedRun, feed, target);
      expect(group.type).toBe("expand-work-group");
      if (group.type !== "expand-work-group") throw new Error("Missing runless work group");
      const expandedGroup = deriveThreadFeedPresentation(
        feed,
        null,
        expandedRuns,
        new Set([group.groupId]),
      );
      const row = threadFindRevealAction(expandedGroup, feed, target);
      expect(row.type).toBe("expand-work-row");
      if (row.type !== "expand-work-row") throw new Error("Missing task row");
      const action = threadFindRevealAction(expandedGroup, feed, target, { [row.rowId]: true });
      expect(action).toMatchObject({ type: "scroll-work-row", rowId: row.rowId });
      if (action.type !== "scroll-work-row") throw new Error("Missing inner scroll");
      const workGroup = expandedGroup[action.index];
      if (workGroup?.type !== "activity-group") throw new Error("Missing revealed group");
      expect(workGroup.activities.findIndex((activity) => activity.id === action.rowId)).toBe(24);
      expect(workGroup.activities[24]?.getFullDetail()).toBe(
        "The target after twenty-four commands (pending)",
      );
    },
  );
});
