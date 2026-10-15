import type { OrchestrationV2Run, OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { cap, fixed, iso, SHORT_TEXT, type Candidate, type EventReads } from "./candidate.ts";

/** Turn and request events: the ones that read the thread to say how a turn ended or what an agent asks. */

const TERMINAL_TURNS = new Set(["completed", "failed", "interrupted", "cancelled"]);

/** The agent's last words in a run, and why it failed when it did. */
const finalText = (reads: EventReads, run: OrchestrationV2Run) =>
  reads.threads
    .getThreadRecords(run.threadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunId: run.id,
      turnItemTypes: ["assistant_message", "error"],
    })
    .pipe(
      Effect.map((records) => ({
        lastMessage: cap(subagentResultForRun(records, { ...run, status: "completed" }).text),
        error:
          run.status === "failed"
            ? cap(subagentResultForRun(records, run).text) || "The turn failed."
            : null,
      })),
    );

export const runCandidates = (run: OrchestrationV2Run): Candidate[] => {
  const turn = { provider: run.providerInstanceId, model: run.modelSelection.model };
  if (run.status === "running")
    return [
      {
        name: "turn.started",
        id: `turn.started:${run.id}`,
        build: fixed(() => ({ ...turn, startedAt: iso(run.startedAt) })),
      },
    ];
  if (!TERMINAL_TURNS.has(run.status)) return [];
  return [
    {
      name: "turn.finished",
      id: `turn.finished:${run.id}`,
      build: (reads) =>
        Effect.gen(function* () {
          const shell = yield* reads.shell;
          const text = yield* finalText(reads, run);
          return {
            ...turn,
            status: run.status,
            ...text,
            errorClass: shell?.lastErrorClass ?? null,
            usageLimitResetAt: shell?.usageLimitResetAt ?? null,
            branch: shell?.branch ?? null,
            worktreePath: shell?.worktreePath ?? null,
            startedAt: iso(run.startedAt),
            finishedAt: iso(run.completedAt),
          };
        }),
    },
  ];
};

const REQUEST_KIND: Record<string, string> = {
  user_input: "question",
  auth_refresh: "sign-in",
  dynamic_tool_call: "tool",
};
const REQUEST_SUMMARY: Record<string, string> = {
  command: "Approve a command",
  "file-read": "Approve reading files",
  "file-change": "Approve file changes",
  "mcp-elicitation": "Answer a tool's request",
  permission: "Grant a permission",
  user_input: "Answer a question",
  auth_refresh: "Sign in again",
  dynamic_tool_call: "Run a tool",
};

/** What a pending request asks, from its turn item when the agent wrote one. */
const requestSummary = (reads: EventReads, threadId: string, requestId: string, kind: string) =>
  reads.threads
    .getThreadRecords(threadId as never, ["turnItems"], {
      turnItemTypes: ["approval_request", "user_input_request"],
    })
    .pipe(
      Effect.map(({ turnItems }) => {
        const item = turnItems.find(
          (candidate) => "requestId" in candidate && candidate.requestId === requestId,
        );
        const text =
          item?.type === "approval_request"
            ? item.prompt
            : item?.type === "user_input_request"
              ? item.questions.map((question) => question.question).join("\n")
              : undefined;
        return cap(text?.trim() || REQUEST_SUMMARY[kind] || "Respond to the agent", SHORT_TEXT);
      }),
    );

/** A request turning pending is an agent waiting on a person; anything after is its answer. */
export const requestCandidates = (
  threadId: string,
  request: OrchestrationV2RuntimeRequest,
): Candidate[] => {
  if (request.status === "pending")
    return [
      {
        name: "input.requested",
        id: `input.requested:${request.id}`,
        build: (reads) =>
          requestSummary(reads, threadId, request.id, request.kind).pipe(
            Effect.map((summary) => ({
              requestId: request.id,
              kind: REQUEST_KIND[request.kind] ?? "approval",
              request: request.kind,
              summary,
            })),
          ),
      },
    ];
  return [
    {
      name: "input.resolved",
      id: `input.resolved:${request.id}`,
      build: fixed(() => ({
        requestId: request.id,
        request: request.kind,
        status: request.status,
        decision: request.decision ?? null,
      })),
    },
  ];
};
