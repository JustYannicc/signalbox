import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { SearchDocument } from "../search/SearchIndex.ts";

const THREAD_ROW_ID = "thread";
const TOOL_OUTPUT_EDGE = 320;
const TOOL_COMMAND_LIMIT = 1_000;
const SECRET_KEY = /secret|token|password|credential|authorization|cookie|base64|image|binary/i;
const sliceText = (text: string, start: number, end: number) => {
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start += 1;
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end -= 1;
  return text.slice(start, end);
};
const clip = (text: string, limit: number) =>
  text.length <= limit ? text : sliceText(text, 0, limit);

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

const document = (
  projection: OrchestrationV2ThreadProjection,
  input: Omit<SearchDocument, "threadId">,
): SearchDocument => ({ threadId: projection.thread.id, ...input });

function pullRequestText(projection: OrchestrationV2ThreadProjection): string {
  return threadPullRequestsOf(projection.thread)
    .filter((link) => link.source !== "stack-dismissed")
    .map((link) =>
      [String(link.number), link.snapshot?.title ?? "", link.url].filter(Boolean).join(" "),
    )
    .join("\n");
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((part) => {
        if (
          typeof part !== "object" ||
          part === null ||
          !("type" in part) ||
          part.type !== "text"
        ) {
          return [];
        }
        return "text" in part && typeof part.text === "string" ? [part.text] : [];
      })
      .join("\n");
  }
  if (typeof value === "object" && value !== null && "content" in value) {
    return toolResultText(value.content);
  }
  return "";
}

function safeInputText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  if (typeof value !== "object" || value === null || depth >= 3) return "";
  if (Array.isArray(value))
    return value
      .map((part) => safeInputText(part, depth + 1))
      .filter(Boolean)
      .join(" ");
  return Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, item]) => {
      const text = safeInputText(item, depth + 1);
      return text.length === 0 ? "" : `${key}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

const outputExcerpt = (output: string) => {
  const text = output.trim();
  return text.length <= TOOL_OUTPUT_EDGE * 2
    ? text
    : `${sliceText(text, 0, TOOL_OUTPUT_EDGE)}\n${sliceText(text, text.length - TOOL_OUTPUT_EDGE, text.length)}`;
};

export function documentForProjectedItem(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ThreadProjection["visibleTurnItems"][number],
): SearchDocument | null {
  const { item } = row;
  const common = {
    itemId: String(item.id),
    runId: item.runId === null ? null : String(item.runId),
    position: row.position,
    createdAt: iso(item.startedAt ?? item.updatedAt),
  };

  switch (item.type) {
    case "user_message":
    case "assistant_message": {
      const terminal =
        item.type === "user_message" ||
        item.status === "completed" ||
        item.status === "failed" ||
        item.status === "interrupted";
      if (!terminal) return null;
      const text = item.text.trim();
      if (text.length === 0) return null;
      return document(projection, {
        ...common,
        entryId: String(item.messageId),
        kind: item.type === "user_message" ? "user" : "assistant",
        text,
      });
    }
    case "proposed_plan": {
      if (item.status !== "completed") return null;
      const text = item.markdown.trim();
      return text.length === 0
        ? null
        : document(projection, { ...common, entryId: String(item.id), kind: "summary", text });
    }
    case "compaction":
    case "handoff": {
      if (item.status !== "completed") return null;
      const text = item.summary?.trim() ?? "";
      return text.length === 0
        ? null
        : document(projection, { ...common, entryId: String(item.id), kind: "summary", text });
    }
    case "command_execution": {
      if (
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "cancelled" &&
        item.status !== "interrupted"
      ) {
        return null;
      }
      const excerpt = outputExcerpt(item.output ?? "");
      const status =
        item.exitCode === undefined ? item.status : `${item.status} exit ${item.exitCode}`;
      return document(projection, {
        ...common,
        entryId: String(item.id),
        kind: "tool",
        text: [clip(item.input.trim(), TOOL_COMMAND_LIMIT), status, excerpt]
          .filter(Boolean)
          .join("\n"),
      });
    }
    case "dynamic_tool": {
      if (
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "cancelled" &&
        item.status !== "interrupted"
      ) {
        return null;
      }
      const input = safeInputText(item.input);
      const output = item.outputOmitted === true ? "" : outputExcerpt(toolResultText(item.output));
      return document(projection, {
        ...common,
        entryId: String(item.id),
        kind: "tool",
        text: [
          item.toolName ?? "",
          item.status,
          input ? clip(input, TOOL_COMMAND_LIMIT) : "",
          output,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    case "approval_request":
    case "user_input_request": {
      const detail: Array<string> =
        item.type === "approval_request"
          ? [
              item.status,
              item.prompt ?? "",
              item.appName ?? "",
              ...(item.options ?? []).flatMap((option) => [
                option.decision,
                option.label,
                option.warning ?? "",
              ]),
            ]
          : [
              item.status,
              ...item.questions.flatMap((question) => [
                question.header,
                question.question,
                question.initialAnswer ?? "",
                ...question.options.flatMap((option) => [
                  option.label,
                  option.description,
                  option.value ?? "",
                ]),
              ]),
            ];
      const text = detail.filter((part) => part.trim().length > 0).join("\n");
      return document(projection, { ...common, entryId: String(item.id), kind: "approval", text });
    }
    default:
      return null;
  }
}

/** Searchable rows only; streaming, reasoning, full tool output and transcript blobs never enter the feed. */
function threadDocuments(projection: OrchestrationV2ThreadProjection): Array<SearchDocument> {
  const thread = projection.thread;
  const pullRequests = pullRequestText(projection);
  const threadText = [thread.title, pullRequests].filter(Boolean).join("\n");
  const rows: Array<SearchDocument> = [
    document(projection, {
      itemId: THREAD_ROW_ID,
      entryId: THREAD_ROW_ID,
      runId: null,
      position: 0,
      kind: "thread",
      text: threadText,
      createdAt: iso(thread.createdAt),
    }),
  ];

  return rows;
}

export function documentsForProjection(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<SearchDocument> {
  if (projection.thread.deletedAt !== null) return [];
  const rows = threadDocuments(projection);
  for (const row of projection.visibleTurnItems) {
    const indexed = documentForProjectedItem(projection, row);
    if (indexed !== null) rows.push(indexed);
  }
  return rows.toSorted(
    (left, right) => left.position - right.position || left.itemId.localeCompare(right.itemId),
  );
}

export function documentsForItems(
  projection: OrchestrationV2ThreadProjection,
  itemIds: ReadonlyArray<string>,
): ReadonlyArray<SearchDocument> {
  if (projection.thread.deletedAt !== null) return [];
  const ids = new Set(itemIds.length === 0 ? [THREAD_ROW_ID] : itemIds);
  const documents = ids.has(THREAD_ROW_ID)
    ? threadDocuments(projection).filter((row) => ids.has(row.itemId))
    : [];
  for (const row of projection.visibleTurnItems) {
    if (!ids.has(String(row.item.id))) continue;
    const selected = documentForProjectedItem(projection, row);
    if (selected !== null) documents.push(selected);
  }
  return documents;
}

/** Stable item id used for the thread title and pull-request row. */
export const threadSearchRowId = THREAD_ROW_ID;
