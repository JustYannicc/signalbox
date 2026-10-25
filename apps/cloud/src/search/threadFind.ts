import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { searchableMessageSegments, searchablePlanSegments } from "@t3tools/shared/threadFindText";
import {
  createThreadFindMatchEvidence,
  type ThreadFindEvidenceDocument,
} from "@t3tools/shared/threadFindMatchEvidence";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as Data from "effect/Data";
import { documentForProjectedItem } from "../thread/searchDocuments.ts";

interface FindRow {
  readonly position: number;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}
interface FindDocument extends FindRow {
  readonly entryId: string;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly count: number;
  readonly text: ThreadFindEvidenceDocument | null;
}
class TextKey extends Data.Class<{
  text: string;
  role: "user" | "assistant" | "plan";
  streaming: boolean;
  hasContext: boolean;
  cwd: string | undefined;
  skills: NonNullable<OrchestrationV2SearchThreadInput["skills"]>;
}> {}

function textKey(
  item: OrchestrationV2TurnItem,
  cwd: string | undefined,
  skills: TextKey["skills"],
) {
  return new TextKey({
    text:
      item.type === "proposed_plan"
        ? item.markdown
        : item.type === "user_message" || item.type === "assistant_message"
          ? item.text
          : "",
    role:
      item.type === "proposed_plan" ? "plan" : item.type === "user_message" ? "user" : "assistant",
    streaming: item.type === "assistant_message" && item.streaming,
    hasContext: item.type === "user_message" && item.context !== undefined,
    cwd,
    skills,
  });
}

function parseText(key: TextKey): readonly string[] {
  return key.role === "plan"
    ? searchablePlanSegments(key.text, key.cwd)
    : (searchableMessageSegments(
        {
          role: key.role,
          text: key.text,
          streaming: key.streaming,
          context: key.hasContext ? { version: 1, records: [] } : undefined,
        },
        key.cwd,
        key.skills,
      ) ?? []);
}

function searchableRows(items: readonly OrchestrationV2ProjectedTurnItem[]) {
  const foldedAnswers = new Set(
    items.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [`async-answer:${item.questionAnswer.requestId}`]
        : [],
    ),
  );
  return items.filter(
    ({ item }) => !(item.type === "user_message" && foldedAnswers.has(item.messageId)),
  );
}

function documentFor(
  row: OrchestrationV2ProjectedTurnItem,
  count: number,
  text: ThreadFindEvidenceDocument | null,
): FindDocument {
  return {
    position: row.position,
    visibility: row.visibility,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    entryId:
      row.item.type === "user_message" || row.item.type === "assistant_message"
        ? row.item.messageId
        : row.item.id,
    runId: row.item.runId,
    count,
    text,
  };
}

function countSegments(segments: readonly string[], query: string) {
  return segments.reduce((sum, text) => sum + countThreadSearchOccurrences(text, query), 0);
}

function selectMatch(
  documents: readonly FindDocument[],
  input: Pick<OrchestrationV2SearchThreadInput, "index" | "start" | "offset">,
) {
  const totalMatches = documents.reduce((sum, doc) => sum + doc.count, 0);
  let requestedIndex = input.index ?? 0;
  if (input.index === undefined && input.start) {
    const startIndex = documents.findIndex((doc) => doc.entryId === input.start?.entryId);
    if (startIndex >= 0) {
      requestedIndex =
        documents.slice(0, startIndex).reduce((sum, doc) => sum + doc.count, 0) +
        Math.min(input.start.occurrence, documents[startIndex]!.count);
      if (requestedIndex >= totalMatches) requestedIndex = 0;
    }
  }
  const activeIndex =
    input.index === undefined && totalMatches > 0
      ? (((requestedIndex + (input.offset ?? 0)) % totalMatches) + totalMatches) % totalMatches
      : Math.min(requestedIndex, Math.max(0, totalMatches - 1));
  let occurrence = activeIndex;
  for (const document of documents) {
    if (occurrence < document.count) return { totalMatches, activeIndex, document, occurrence };
    occurrence -= document.count;
  }
  return { totalMatches, activeIndex, document: null, occurrence: 0 };
}

/** Literal Find scans current items, including the bounded excerpts indexed for tools. */
export function findProjectedThreadItems(
  projection: OrchestrationV2ThreadProjection,
  input: OrchestrationV2SearchThreadInput,
  snapshotSequence: number,
  cwd?: string,
): OrchestrationV2SearchThreadResult {
  const rows = searchableRows(projection.visibleTurnItems);
  const docs = rows.map((row) => {
    if (!["user_message", "assistant_message", "proposed_plan"].includes(row.item.type)) {
      return documentFor(
        row,
        countSegments([documentForProjectedItem(projection, row)?.text ?? ""], input.query),
        null,
      );
    }
    const key = textKey(row.item, cwd, input.skills ?? []);
    const segments = parseText(key);
    return documentFor(row, countSegments(segments, input.query), {
      source: key.text,
      segments: segments.map((text) => ({ text })),
    });
  });
  return resultForSelection(selectMatch(docs, input), docs, snapshotSequence, input.query);
}

function resultForSelection(
  selected: ReturnType<typeof selectMatch>,
  documents: readonly FindDocument[],
  snapshotSequence: number,
  query: string,
): OrchestrationV2SearchThreadResult {
  const evidence = selected.document?.text
    ? createThreadFindMatchEvidence(selected.document.text, query, selected.occurrence)
    : null;
  let startIndex = 0;
  const entries = documents.flatMap(({ entryId, runId, count }) => {
    const entry = { entryId, runId, count, startIndex };
    startIndex += count;
    return count > 0 ? [entry] : [];
  });
  const selectedEntry = entries.findIndex((entry) => entry.entryId === selected.document?.entryId);
  const navigation =
    entries.length <= 17
      ? entries
      : Array.from(
          { length: 17 },
          (_, i) => entries[(selectedEntry + i - 8 + entries.length) % entries.length]!,
        );
  return {
    snapshotSequence,
    totalMatches: selected.totalMatches,
    activeIndex: selected.activeIndex,
    navigation,
    match:
      selected.document === null
        ? null
        : {
            entryId: selected.document.entryId,
            runId: selected.document.runId,
            occurrence: selected.occurrence,
            ...(evidence === null ? {} : { evidence }),
          },
  };
}
