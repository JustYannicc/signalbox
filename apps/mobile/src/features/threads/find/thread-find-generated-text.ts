import type { MarkdownSourceSelection } from "react-native-enriched-markdown";
import type { ThreadFindDocument, ThreadFindDisplaySlot } from "@t3tools/shared/threadFindText";

import {
  resolveThreadFindOccurrence,
  type ThreadFindMarkdownRequest,
} from "./thread-find-markdown";

/** Numeric entities keep generated labels literal and give every scalar a source-owned range. */
export function threadFindGeneratedMarkdown(text: string) {
  const boundaries = new Map<number, number>([[0, 0]]);
  let markdown = "";
  let offset = 0;
  for (const character of text) {
    markdown += `&#${character.codePointAt(0)!};`;
    offset += character.length;
    boundaries.set(offset, markdown.length);
  }
  return { markdown, boundaries };
}

export function threadFindGeneratedSelection(input: {
  readonly document: ThreadFindDocument;
  readonly slot: ThreadFindDisplaySlot;
  readonly revision: string;
  readonly request: ThreadFindMarkdownRequest | null;
}): MarkdownSourceSelection | null {
  const { request, slot } = input;
  if (!request || request.revision !== input.revision) return null;
  const resolved = resolveThreadFindOccurrence(input.document, request);
  if (!resolved || resolved.ranges.length || resolved.slots.length !== 1) return null;
  const selected = resolved.slots[0]!;
  if (
    selected.slot.kind !== slot.kind ||
    selected.slot.sourceStart !== slot.sourceStart ||
    selected.slot.sourceEnd !== slot.sourceEnd ||
    selected.slot.text !== slot.text
  )
    return null;
  const rendered = threadFindGeneratedMarkdown(slot.text);
  const start = rendered.boundaries.get(selected.start);
  const end = rendered.boundaries.get(selected.end);
  if (start === undefined || end === undefined || start >= end) return null;
  return {
    version: 1,
    requestId: request.requestId,
    revision: input.revision,
    sourceMarkdown: rendered.markdown,
    ranges: [{ start, end }],
  };
}
