export const THREAD_TOOL_SEARCH_OUTPUT_EDGE = 320;
export const THREAD_TOOL_SEARCH_COMMAND_LIMIT = 1_000;

export function threadToolSearchWindows(text: string, kind: "command" | "output") {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const window = (from: number, to: number) => ({
    start: from > 0 && /[\uDC00-\uDFFF]/u.test(text[from] ?? "") ? from + 1 : from,
    end: to < text.length && /[\uD800-\uDBFF]/u.test(text[to - 1] ?? "") ? to - 1 : to,
  });
  if (end <= start) return [];
  if (kind === "command")
    return [window(start, Math.min(end, start + THREAD_TOOL_SEARCH_COMMAND_LIMIT))];
  if (end - start <= THREAD_TOOL_SEARCH_OUTPUT_EDGE * 2) return [window(start, end)];
  return [
    window(start, start + THREAD_TOOL_SEARCH_OUTPUT_EDGE),
    window(end - THREAD_TOOL_SEARCH_OUTPUT_EDGE, end),
  ];
}

interface ThreadSearchTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

function foldThreadSearchCase(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;

  let folded = "";
  for (const character of text) {
    const loweredCharacter = character.toLowerCase().replace(/ς/g, "σ");
    folded += loweredCharacter.length === character.length ? loweredCharacter : character;
  }
  return folded;
}

function scanThreadSearchOccurrences(text: string, query: string, offsets?: number[]): number {
  if (text.length === 0 || query.length === 0) return 0;

  const foldedText = foldThreadSearchCase(text);
  const foldedQuery = foldThreadSearchCase(query);
  let count = 0;
  let cursor = 0;

  while (cursor <= foldedText.length - foldedQuery.length) {
    const offset = foldedText.indexOf(foldedQuery, cursor);
    if (offset === -1) break;
    offsets?.push(offset);
    count += 1;
    cursor = offset + foldedQuery.length;
  }
  return count;
}

export function countThreadSearchOccurrences(text: string, query: string): number {
  return scanThreadSearchOccurrences(text, query);
}

export function findThreadSearchOccurrences(text: string, query: string): number[] {
  const offsets: number[] = [];
  scanThreadSearchOccurrences(text, query, offsets);
  return offsets;
}

export function splitThreadSearchText(text: string, query: string): ThreadSearchTextPart[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [{ text, highlighted: false, start: 0 }];
  }

  const parts: ThreadSearchTextPart[] = [];
  let cursor = 0;
  for (const offset of findThreadSearchOccurrences(text, normalizedQuery)) {
    if (offset > cursor) {
      parts.push({ text: text.slice(cursor, offset), highlighted: false, start: cursor });
    }
    parts.push({
      text: text.slice(offset, offset + normalizedQuery.length),
      highlighted: true,
      start: offset,
    });
    cursor = offset + normalizedQuery.length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}
