import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import { cap, fixed, SHORT_TEXT, TERMINAL_ITEMS, type Candidate } from "./candidate.ts";

const toolName = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "command_execution":
      return "command";
    case "dynamic_tool":
      return item.toolName ?? "tool";
    default:
      return item.type;
  }
};
const toolInput = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "command_execution":
      return item.input;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.join(", ") ?? null;
    case "dynamic_tool":
      return JSON.stringify(item.input ?? null);
    default:
      return null;
  }
};
const toolOutput = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "command_execution":
      return item.output ?? null;
    case "dynamic_tool":
      return item.output === undefined ? null : JSON.stringify(item.output);
    case "file_search":
      return item.results?.map((result) => result.fileName).join("\n") ?? null;
    case "web_search":
      return item.results ? JSON.stringify(item.results) : null;
    default:
      return null;
  }
};
const TOOL_ITEMS = new Set(["command_execution", "file_search", "web_search", "dynamic_tool"]);

/** Public events for one turn item update: tools, file edits, requests, plans, errors. */
export const itemCandidates = (eventId: string, item: OrchestrationV2TurnItem): Candidate[] => {
  const base = { itemId: item.id, title: item.title };
  if (TOOL_ITEMS.has(item.type)) {
    if (item.status === "running")
      return [
        {
          name: "tool.started",
          id: `tool.started:${item.id}`,
          build: fixed(() => ({
            ...base,
            tool: toolName(item),
            input: cap(toolInput(item), SHORT_TEXT),
          })),
        },
      ];
    if (!TERMINAL_ITEMS.has(item.status)) return [];
    const failed =
      item.status !== "completed" ||
      (item.type === "command_execution" &&
        (item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0));
    return [
      {
        name: "tool.called",
        id: `tool.called:${item.id}`,
        build: fixed(() => ({
          ...base,
          tool: toolName(item),
          status: item.status,
          input: cap(toolInput(item), SHORT_TEXT),
          output: cap(toolOutput(item), SHORT_TEXT),
          exitCode: item.type === "command_execution" ? (item.exitCode ?? null) : null,
          failed,
        })),
      },
    ];
  }
  switch (item.type) {
    case "file_change":
      return item.status !== "completed"
        ? []
        : [
            {
              name: "file.changed",
              id: `file.changed:${item.id}`,
              build: fixed(() => ({
                ...base,
                fileName: item.fileName,
                paths: item.changes?.map((change) => change.path) ?? [item.fileName],
                additions: item.additions ?? null,
                deletions: item.deletions ?? null,
              })),
            },
          ];
    case "approval_request":
      return [
        {
          name: "approval.requested",
          id: `approval.requested:${item.id}`,
          build: fixed(() => ({
            requestId: item.requestId,
            request: item.requestKind,
            prompt: cap(item.prompt, SHORT_TEXT),
            appName: item.appName ?? null,
          })),
        },
      ];
    case "user_input_request":
      return [
        {
          name: "question.asked",
          id: `question.asked:${item.id}`,
          build: fixed(() => ({
            requestId: item.requestId,
            questions: item.questions.map((question) => question.question),
          })),
        },
      ];
    case "proposed_plan":
      return item.streaming
        ? []
        : [
            {
              name: "plan.proposed",
              id: `plan.proposed:${item.id}`,
              build: fixed(() => ({ planId: item.planId, markdown: cap(item.markdown) })),
            },
          ];
    case "todo_list":
      return [
        {
          name: "todos.updated",
          id: eventId,
          build: fixed(() => ({
            steps: item.steps.map((step) => ({ text: step.text, status: step.status })),
            explanation: item.explanation ?? null,
          })),
        },
      ];
    case "error":
      return [
        {
          name: "agent.error",
          id: `agent.error:${item.id}`,
          build: fixed(() => ({
            message: item.failure.message,
            class: item.failure.class,
            retryable: item.failure.retryable,
          })),
        },
      ];
    case "compaction":
      return item.status !== "completed"
        ? []
        : [
            {
              name: "context.compacted",
              id: `context.compacted:${item.id}`,
              build: fixed(() => ({
                summary: cap(item.summary, SHORT_TEXT),
                beforeTokenCount: item.beforeTokenCount ?? null,
                afterTokenCount: item.afterTokenCount ?? null,
              })),
            },
          ];
    default:
      return [];
  }
};
