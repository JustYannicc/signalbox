import {
  OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { threadShellFromProjection } from "../thread/threadProjection.ts";

const iso = (time: DateTime.Utc | null | undefined) =>
  time == null ? null : DateTime.formatIso(time);

export const listItem = (
  thread: OrchestrationV2ThreadShell,
  now: number,
): OrchestratorMcpThreadListItem => ({
  threadId: thread.id,
  title: thread.title,
  createdBy: thread.createdBy,
  creationSource: thread.creationSource,
  status: thread.status,
  latestRunId: thread.latestRunId,
  providerInstanceId: thread.providerInstanceId,
  model: thread.modelSelection.model,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  linkedPullRequest: thread.linkedPullRequest ?? null,
  settled: thread.settledAt !== null,
  settledAt: iso(thread.settledAt),
  snoozed: thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > now,
  snoozedUntil: iso(thread.snoozedUntil),
  parentThreadId: thread.lineage.parentThreadId,
  relationshipToParent: thread.lineage.relationshipToParent,
  itemCount: thread.itemCount,
  createdAt: DateTime.formatIso(thread.createdAt),
  updatedAt: DateTime.formatIso(thread.updatedAt),
});

const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItem));

/** Structured tool input and output stay on their own timeline row and can be read in chunks. */
const textOf = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "command_execution":
      return `$ ${item.input}\n${item.output ?? ""}`;
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message;
    case "error":
      return item.failure.message;
    default:
      return encodeItem(item);
  }
};

export const readPage = (
  projection: OrchestrationV2ThreadProjection,
  input: OrchestratorMcpThreadReadInput,
  now: number,
): OrchestratorMcpThreadReadResult => {
  const shell = threadShellFromProjection(projection);
  const row = listItem(shell, now);
  const thread: OrchestratorMcpThreadDetail = {
    ...row,
    projectId: shell.projectId,
    activeRunId: shell.activeRunId,
    titleRegeneration:
      shell.titleRegeneration == null
        ? null
        : {
            ...shell.titleRegeneration,
            startedAt: DateTime.formatIso(shell.titleRegeneration.startedAt),
          },
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    runCount: projection.runs.length,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: shell.archivedAt !== null,
  };
  const selected = projection.turnItems
    .filter((item) =>
      input.itemId !== undefined
        ? item.id === input.itemId
        : item.ordinal > (input.afterPosition ?? -1) &&
          (input.view === "activity" ||
            item.type === "user_message" ||
            item.type === "assistant_message"),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const page = selected.slice(0, input.limit ?? 50);
  return {
    thread,
    recentRuns: projection.runs
      .toSorted((a, b) => b.ordinal - a.ordinal)
      .slice(0, input.runLimit ?? 10)
      .map((run) => ({
        runId: run.id,
        ordinal: run.ordinal,
        status: run.status,
        providerInstanceId: run.providerInstanceId,
        model: run.modelSelection.model,
        requestedAt: DateTime.formatIso(run.requestedAt),
        startedAt: iso(run.startedAt),
        completedAt: iso(run.completedAt),
      })),
    items: page.map((item) => {
      const messageId =
        item.type === "user_message" || item.type === "assistant_message" ? item.messageId : null;
      const message = projection.messages.find((candidate) => candidate.id === messageId);
      const text = textOf(item);
      const offset = input.itemId === undefined ? 0 : (input.textOffset ?? 0);
      const end = offset + (input.maxCharsPerItem ?? 20_000);
      return {
        position: item.ordinal,
        visibility: "local",
        sourceThreadId: shell.id,
        itemId: item.id,
        ...(item.type === "subagent" ? { subagentId: item.subagentId } : {}),
        runId: item.runId,
        messageId,
        createdBy: message?.createdBy ?? null,
        creationSource: message?.creationSource ?? null,
        type: item.type,
        status: item.status,
        title: item.title,
        text: text.slice(offset, end),
        textTruncated: text.length > end,
        nextTextOffset: text.length > end ? end : null,
        updatedAt: DateTime.formatIso(item.updatedAt),
      };
    }),
    nextPosition: page.at(-1)?.ordinal ?? null,
    hasMore: selected.length > page.length,
  };
};
