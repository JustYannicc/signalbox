import type { Nodes } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { OrchestrationV2ThreadFindMatchEvidence } from "@t3tools/contracts";
import type {
  MarkdownSourceSelection,
  MarkdownSourceLinkPillContent,
  MarkdownDisplayLabelRange,
} from "react-native-enriched-markdown";
import { matchInlineSkills, type InlineSkill } from "@t3tools/shared/inlineSkills";
import { inlineCodeFilePathCandidate } from "@t3tools/shared/markdownLinks";
import { markdownTextSourceMap } from "@t3tools/shared/markdownTextSourceMap";
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { verifyThreadFindMatchEvidence } from "@t3tools/shared/threadFindMatchEvidence";
import {
  resolveThreadFindRange,
  type ThreadFindDocument,
  type ThreadFindDisplaySlot,
  type ThreadFindResolvedRange,
} from "@t3tools/shared/threadFindProvenance";
import {
  composeTextSourceMaps,
  isCompleteTextSourceMap,
  mergeTextRanges,
  sourceRangeToText,
  textRangeToSource,
  type TextRange,
  type TextSourceMap,
} from "@t3tools/shared/textSourceMap";
import {
  markdownWithHtmlSourceMap,
  markdownWithTableBreaksSourceMap,
} from "../../../lib/markdownDocument";

const parser = unified().use(remarkParse).use(remarkGfm);

export interface ThreadFindMarkdownRequest {
  readonly query: string;
  readonly occurrence: number;
  readonly requestId: string;
  readonly revision: string;
  readonly evidence?: OrchestrationV2ThreadFindMatchEvidence | null;
}

export interface ThreadFindGeneratedSelection {
  readonly slot: ThreadFindDisplaySlot;
  readonly start: number;
  readonly end: number;
}

export interface ThreadFindMarkdownManifest {
  readonly markdown: string;
  readonly sourceLinkPillContent: readonly MarkdownSourceLinkPillContent[];
  readonly sourceSelection: MarkdownSourceSelection | null;
  readonly selectedGeneratedSlot: ThreadFindGeneratedSelection | null;
}

/** The wrapper must use preparedMarkdown so native parses these exact offsets. */
export function prepareThreadFindMarkdown(sourceMap: TextSourceMap): TextSourceMap {
  const html = composeTextSourceMaps(sourceMap, markdownWithHtmlSourceMap(sourceMap.text));
  return composeTextSourceMaps(html, markdownWithTableBreaksSourceMap(html.text));
}

function nodeRange(node: Nodes): TextRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined || start === end ? null : { start, end };
}

function leafMap(markdown: string, node: Nodes): TextSourceMap | null {
  if (node.type !== "text" && node.type !== "inlineCode") return null;
  return markdownTextSourceMap(
    markdown,
    node,
    node.value,
    node.type === "inlineCode" ? "inlineCode" : "text",
  );
}

function labelAnchor(markdown: string, node: Nodes): TextRange | null {
  const ranges: TextRange[] = [];
  const visit = (child: Nodes) => {
    const map = leafMap(markdown, child);
    if (map) {
      for (const span of map.spans) {
        if (span.kind !== "insert") ranges.push({ start: span.sourceStart, end: span.sourceEnd });
      }
    } else if ("children" in child) child.children.forEach(visit);
  };
  visit(node);
  return ranges.length
    ? {
        start: Math.min(...ranges.map((range) => range.start)),
        end: Math.max(...ranges.map((range) => range.end)),
      }
    : null;
}

function nativeLabelAnchors(markdown: string, skills: readonly InlineSkill[]) {
  const anchors: Array<{ anchor: TextRange; owner: TextRange }> = [];
  const visit = (node: Nodes, recognizeSkills = false) => {
    const owner = nodeRange(node);
    if (node.type === "link" || node.type === "linkReference") {
      const anchor = labelAnchor(markdown, node);
      if (anchor && owner) anchors.push({ anchor, owner });
      return;
    }
    if (node.type === "inlineCode") {
      if (node.value === node.value.trim() && inlineCodeFilePathCandidate(node.value)) {
        const anchor = labelAnchor(markdown, node);
        if (anchor && owner) anchors.push({ anchor, owner });
      }
      return;
    }
    if (node.type === "text" && recognizeSkills) {
      const map = leafMap(markdown, node);
      for (const match of matchInlineSkills(node.value, skills)) {
        const ranges = map && textRangeToSource(map, match);
        if (ranges?.length === 1) anchors.push({ anchor: ranges[0]!, owner: ranges[0]! });
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        visit(child, recognizeSkills || node.type === "paragraph" || node.type === "listItem");
      }
    }
  };
  visit(parser.parse(markdown));
  return anchors;
}

function rangeKey(range: TextRange): string {
  return `${range.start}:${range.end}`;
}

function sameSlot(left: ThreadFindDisplaySlot, right: ThreadFindDisplaySlot): boolean {
  return (
    left.kind === right.kind &&
    left.sourceStart === right.sourceStart &&
    left.sourceEnd === right.sourceEnd &&
    left.text === right.text
  );
}

function overlapsSlot(map: TextSourceMap, slot: ThreadFindDisplaySlot): boolean {
  return map.spans.some(
    (span) =>
      span.kind !== "insert" &&
      span.sourceStart < slot.sourceEnd &&
      span.sourceEnd > slot.sourceStart,
  );
}

function uniqueSourceOwnership(map: TextSourceMap, range: TextRange): boolean {
  const covered = map.spans.flatMap((span) => {
    const start = Math.max(range.start, span.sourceStart);
    const end = Math.min(range.end, span.sourceEnd);
    return span.kind === "insert" || start >= end ? [] : [{ start, end }];
  });
  let cursor = range.start;
  for (const part of covered.sort((left, right) => left.start - right.start)) {
    if (part.start !== cursor) return false;
    cursor = part.end;
  }
  return cursor === range.end;
}

export function resolveThreadFindOccurrence(
  document: ThreadFindDocument,
  request: ThreadFindMarkdownRequest,
): ThreadFindResolvedRange | null {
  const query = request.query.trim();
  if (!query || !Number.isSafeInteger(request.occurrence) || request.occurrence < 0) return null;
  if (request.evidence) {
    const verified = verifyThreadFindMatchEvidence(
      document,
      query,
      request.occurrence,
      request.evidence,
    );
    return verified && scalarRange(document.segments[verified.segmentIndex]!.text, verified)
      ? resolveThreadFindRange(document, verified.segmentIndex, verified)
      : null;
  }
  let remaining = request.occurrence;
  for (const [index, segment] of document.segments.entries()) {
    const offsets = findThreadSearchOccurrences(segment.text, query);
    const start = offsets[remaining];
    if (start !== undefined) {
      const range = { start, end: start + query.length };
      return scalarRange(segment.text, range)
        ? resolveThreadFindRange(document, index, range)
        : null;
    }
    remaining -= offsets.length;
  }
  return null;
}

function scalarRange(text: string, range: TextRange): boolean {
  const boundary = (offset: number) =>
    !(
      offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[offset]!)
    );
  return boundary(range.start) && boundary(range.end);
}

/** Occurrence order belongs to the full semantic document, including other components. */
export function createThreadFindMarkdownManifest(input: {
  readonly document: ThreadFindDocument | null;
  readonly sourceMap: TextSourceMap;
  readonly revision: string;
  readonly request?: ThreadFindMarkdownRequest | null;
  readonly skills?: readonly InlineSkill[];
}): ThreadFindMarkdownManifest | null {
  const { document, sourceMap, revision, request } = input;
  if (
    !document ||
    !revision ||
    sourceMap.source !== document.source ||
    !isCompleteTextSourceMap(sourceMap)
  )
    return null;
  const anchors = nativeLabelAnchors(sourceMap.text, input.skills ?? []);
  const owners = new Map<string, typeof anchors>();
  for (const candidate of anchors) {
    for (const interval of [candidate.anchor, candidate.owner]) {
      const source = textRangeToSource(sourceMap, interval);
      if (source?.length !== 1) continue;
      const key = rangeKey(source[0]!);
      const candidates = owners.get(key) ?? [];
      if (!candidates.includes(candidate)) candidates.push(candidate);
      owners.set(key, candidates);
    }
  }
  const labels: Array<{ slot: ThreadFindDisplaySlot; content: MarkdownSourceLinkPillContent }> = [];
  const seenSlots = new Set<string>();
  const seenAnchors = new Set<string>();
  for (const segment of document.segments) {
    for (const run of segment.runs) {
      if (run.target.kind !== "slot" || run.target.slot.kind !== "link-label") continue;
      const slot = run.target.slot;
      const slotKey = JSON.stringify([slot.kind, slot.sourceStart, slot.sourceEnd, slot.text]);
      if (seenSlots.has(slotKey)) continue;
      seenSlots.add(slotKey);
      const candidates =
        owners.get(rangeKey({ start: slot.sourceStart, end: slot.sourceEnd })) ?? [];
      if (candidates.length > 1 || (!candidates.length && overlapsSlot(sourceMap, slot)))
        return null;
      const candidate = candidates[0];
      if (!candidate) continue;
      if (!scalarRange(sourceMap.text, candidate.anchor)) return null;
      const anchorKey = rangeKey(candidate.anchor);
      if (seenAnchors.has(anchorKey)) return null;
      seenAnchors.add(anchorKey);
      labels.push({
        slot,
        content: {
          sourceStart: candidate.anchor.start,
          sourceEnd: candidate.anchor.end,
          label: slot.text,
        },
      });
    }
  }
  const result: ThreadFindMarkdownManifest = {
    markdown: sourceMap.text,
    sourceLinkPillContent: labels.map(({ content }) => content),
    sourceSelection: null,
    selectedGeneratedSlot: null,
  };
  if (!request || !request.requestId || request.revision !== revision) return result;
  const resolved = resolveThreadFindOccurrence(document, request);
  if (!resolved) return result;
  if (
    !resolved.ranges.length &&
    resolved.slots.length === 1 &&
    resolved.slots[0]!.slot.kind !== "link-label"
  ) {
    return { ...result, selectedGeneratedSlot: resolved.slots[0]! };
  }
  const ranges: TextRange[] = [];
  for (const source of resolved.ranges) {
    const projected = sourceRangeToText(sourceMap, source);
    if (
      !projected ||
      !uniqueSourceOwnership(sourceMap, source) ||
      projected.some((range) => !scalarRange(sourceMap.text, range))
    )
      return result;
    ranges.push(...projected);
  }
  const selectedLabels: MarkdownDisplayLabelRange[] = [];
  for (const selection of resolved.slots) {
    const label = labels.find((candidate) => sameSlot(candidate.slot, selection.slot));
    if (!label || !scalarRange(selection.slot.text, selection)) return result;
    selectedLabels.push({
      kind: "link-label",
      sourceStart: label.content.sourceStart,
      sourceEnd: label.content.sourceEnd,
      text: selection.slot.text,
      start: selection.start,
      end: selection.end,
    });
  }
  if (!ranges.length && !selectedLabels.length) return result;
  return {
    ...result,
    sourceSelection: {
      version: 1,
      revision,
      requestId: request.requestId,
      sourceMarkdown: sourceMap.text,
      ranges: mergeTextRanges(ranges.sort((left, right) => left.start - right.start)),
      labels: selectedLabels,
    },
  };
}
