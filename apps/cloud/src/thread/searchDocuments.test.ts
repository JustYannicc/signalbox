import {
  CommandId,
  MessageId,
  PlanId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { documentsForProjection } from "./searchDocuments.ts";
import { findProjectedThreadItems } from "../search/threadFind.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { applyEvents } from "./threadProjection.ts";
import { decide } from "./threadDecider.ts";

const threadId = ThreadId.make("thread-search-documents");
const runId = RunId.make("run-search-documents");
const now = DateTime.makeUnsafe("2026-10-17T10:00:00.000Z");

const createdProjection = (): OrchestrationV2ThreadProjection => {
  const decision = decide(
    null,
    {
      type: "thread.create",
      commandId: CommandId.make("create-search-documents"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("project-search-documents"),
      title: "Search documents",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "signalbox/search-documents",
      worktreePath: null,
    },
    { now },
  );
  if (decision._tag !== "accepted") throw new Error(decision.message);
  const projection = applyEvents(null, decision.events);
  if (projection === null) throw new Error("thread creation produced no projection");

  const pullRequest: ThreadPullRequestLink = {
    host: "github.com",
    repository: "signalbox/search-documents",
    number: 42,
    url: "https://github.com/signalbox/search-documents/pull/42",
    source: "manual",
    linkedAt: "2026-10-17T10:00:00.000Z",
    snapshot: {
      state: "open",
      title: "Search rows use source text",
      headBranch: "signalbox/search-documents",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-10-17T10:00:00.000Z",
      syncedAt: "2026-10-17T10:00:00.000Z",
      checksState: null,
      mergeability: "mergeable",
      reviewDecision: null,
    },
    stack: null,
  };
  return { ...projection, thread: { ...projection.thread, pullRequests: [pullRequest] } };
};

const base = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const row = (item: OrchestrationV2TurnItem, position: number) => ({
  position,
  visibility: "local" as const,
  sourceThreadId: threadId,
  sourceItemId: item.id,
  item,
});

describe("thread search documents", () => {
  it("indexes actual searchable content without adding synthetic prose", () => {
    const command = {
      ...base("command-row", 1),
      type: "command_execution",
      input: "pnpm vp test run searchDocuments.test.ts",
      output: "real command output",
      exitCode: 17,
      status: "failed",
    } satisfies OrchestrationV2TurnItem;
    const dynamicTool = {
      ...base("tool-row", 2),
      type: "dynamic_tool",
      toolName: "list_files",
      input: { path: "src/search", password: "must-not-index", depth: 2 },
      output: {
        content: [
          {
            type: "text",
            text: `${"beginning-token ".repeat(30)}OMITTED_MIDDLE_SENTINEL ${"ending-token ".repeat(30)}`,
          },
        ],
      },
      status: "completed",
    } satisfies OrchestrationV2TurnItem;
    const approval = {
      ...base("approval-row", 3),
      type: "approval_request",
      requestId: RuntimeRequestId.make("approval-request"),
      requestKind: "command",
      prompt: "Run the database migration?",
      appName: "Terminal",
      options: [{ decision: "accept", label: "Run once", warning: "Changes the local database" }],
      status: "pending",
    } satisfies OrchestrationV2TurnItem;
    const question = {
      ...base("question-row", 4),
      type: "user_input_request",
      requestId: RuntimeRequestId.make("input-request"),
      questions: [
        {
          id: "destination",
          header: "Destination",
          question: "Which folder should receive the output?",
          options: [{ label: "Search", description: "The search folder", value: "search" }],
        },
      ],
      status: "pending",
    } satisfies OrchestrationV2TurnItem;
    const plan = {
      ...base("plan-row", 5),
      type: "proposed_plan",
      planId: PlanId.make("plan-search-documents"),
      markdown: "Keep the source wording in search results.",
      streaming: false,
    } satisfies OrchestrationV2TurnItem;
    const userText = `user wording ${"u".repeat(12_000)}`;
    const userMessage = {
      ...base("user-message-row", 6),
      type: "user_message",
      messageId: MessageId.make("user-message-entry"),
      inputIntent: "turn_start",
      text: userText,
      attachments: [],
    } satisfies OrchestrationV2TurnItem;
    const assistantText = `assistant wording ${"a".repeat(12_000)}`;
    const assistantMessage = {
      ...base("assistant-message-row", 7),
      type: "assistant_message",
      messageId: MessageId.make("assistant-message-entry"),
      text: assistantText,
      streaming: false,
    } satisfies OrchestrationV2TurnItem;

    const projection = {
      ...createdProjection(),
      visibleTurnItems: [
        row(command, 11),
        row(dynamicTool, 22),
        row(approval, 33),
        row(question, 44),
        row(plan, 55),
        row(userMessage, 66),
        row(assistantMessage, 77),
      ],
    };
    const documents = documentsForProjection(projection);
    const content = documents.map((document) => document.text).join("\n");
    const byItemId = new Map(documents.map((document) => [document.itemId, document]));

    expect(documents.map((document) => document.kind)).not.toContain("state");
    for (const invented of [
      "Command:",
      "Status:",
      "Tool:",
      "Input:",
      "Output excerpt:",
      "Approval/input",
      "output omitted",
      "…",
      "OMITTED_MIDDLE_SENTINEL",
      "PR #",
      "Thread active",
    ]) {
      expect(content).not.toContain(invented);
    }
    for (const actual of [
      "pnpm vp test run searchDocuments.test.ts",
      "failed exit 17",
      "real command output",
      "list_files",
      "path: src/search",
      "depth: 2",
      "completed",
      "beginning-token",
      "ending-token",
      "Run the database migration?",
      "accept",
      "Run once",
      "Changes the local database",
      "Which folder should receive the output?",
      "The search folder",
      "Keep the source wording in search results.",
      "42 Search rows use source text https://github.com/signalbox/search-documents/pull/42",
    ]) {
      expect(content).toContain(actual);
    }
    expect(content).not.toContain("must-not-index");

    expect(byItemId.get(String(command.id))).toMatchObject({
      entryId: String(command.id),
      runId: String(runId),
      position: 11,
      kind: "tool",
    });
    expect(byItemId.get(String(dynamicTool.id))).toMatchObject({
      entryId: String(dynamicTool.id),
      runId: String(runId),
      position: 22,
      kind: "tool",
    });
    expect(byItemId.get(String(approval.id))).toMatchObject({
      entryId: String(approval.id),
      runId: String(runId),
      position: 33,
      kind: "approval",
    });
    expect(byItemId.get(String(question.id))).toMatchObject({
      entryId: String(question.id),
      runId: String(runId),
      position: 44,
      kind: "approval",
    });
    expect(byItemId.get(String(plan.id))).toMatchObject({
      entryId: String(plan.id),
      runId: String(runId),
      position: 55,
      kind: "summary",
    });
    expect(byItemId.get(String(userMessage.id))).toMatchObject({
      entryId: String(userMessage.messageId),
      runId: String(runId),
      position: 66,
      kind: "user",
      text: userText,
    });
    expect(byItemId.get(String(assistantMessage.id))).toMatchObject({
      entryId: String(assistantMessage.messageId),
      runId: String(runId),
      position: 77,
      kind: "assistant",
      text: assistantText,
    });

    const find = (query: string) => findProjectedThreadItems(projection, { threadId, query }, 91);
    expect(find("pnpm vp test").match?.entryId).toBe(String(command.id));
    expect(find("list_files").match?.entryId).toBe(String(dynamicTool.id));
    expect(find("Run the database migration").match?.entryId).toBe(String(approval.id));
    expect(find("Keep the source wording").match?.entryId).toBe(String(plan.id));
  });
});
