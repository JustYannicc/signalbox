import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

function readOffsets(value: string | null) {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !Number.isInteger(entry[0]) ||
      !Number.isInteger(entry[1]) ||
      entry[0] < 0 ||
      entry[1] <= entry[0]
    )
      return null;
    return { start: Number(entry[0]), end: Number(entry[1]) };
  });
}

// Indexed input omits JSON keys and secrets; offsets retain the actual rendered glyphs.
export function collectThreadFindInputRanges(scope: Element, query: string) {
  const source = scope.getAttribute("data-thread-find-source");
  const offsets = readOffsets(scope.getAttribute("data-thread-find-offsets"));
  if (source === null || offsets === null || offsets.length !== source.length) return [];
  const nodes: { node: Node; start: number; end: number }[] = [];
  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let textLength = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = textLength;
    textLength += node.nodeValue?.length ?? 0;
    nodes.push({ node, start, end: textLength });
  }
  return findThreadSearchOccurrences(source, query).map((offset) => {
    const mapped = offsets.slice(offset, offset + query.length).filter((part) => part !== null);
    const startOffset = mapped[0]?.start;
    const endOffset = mapped.at(-1)?.end;
    if (startOffset === undefined || endOffset === undefined || endOffset > textLength) return null;
    const start = nodes.find((part) => part.start <= startOffset && part.end > startOffset);
    const end = nodes.find((part) => part.start < endOffset && part.end >= endOffset);
    if (!start || !end) return null;
    const range = scope.ownerDocument.createRange();
    range.setStart(start.node, startOffset - start.start);
    range.setEnd(end.node, endOffset - end.start);
    return range;
  });
}
