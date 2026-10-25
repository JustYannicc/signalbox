export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface TextSourceSpan extends TextRange {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly kind: "copy" | "replace" | "insert";
}

/** Every output unit is accounted for; deleted source has no output span. */
export interface TextSourceMap {
  readonly source: string;
  readonly text: string;
  readonly spans: readonly TextSourceSpan[];
}

export interface TextSourceEdit extends TextRange {
  readonly text: string;
  readonly map?: TextSourceMap;
}

export function validTextRange(range: TextRange, length: number): boolean {
  return (
    Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= length
  );
}

export function isCompleteTextSourceMap(map: TextSourceMap): boolean {
  let cursor = 0;
  for (const span of map.spans) {
    if (
      !validTextRange(span, map.text.length) ||
      span.start !== cursor ||
      span.end === cursor ||
      !validTextRange({ start: span.sourceStart, end: span.sourceEnd }, map.source.length)
    )
      return false;
    if (
      span.kind === "copy" &&
      (span.end - span.start !== span.sourceEnd - span.sourceStart ||
        map.text.slice(span.start, span.end) !== map.source.slice(span.sourceStart, span.sourceEnd))
    )
      return false;
    if (
      span.kind === "insert"
        ? span.sourceStart !== span.sourceEnd
        : span.sourceStart === span.sourceEnd
    )
      return false;
    if (span.kind !== "copy" && span.kind !== "replace" && span.kind !== "insert") return false;
    cursor = span.end;
  }
  return cursor === map.text.length;
}

export function identityTextSourceMap(source: string): TextSourceMap {
  return {
    source,
    text: source,
    spans: source.length
      ? [{ start: 0, end: source.length, sourceStart: 0, sourceEnd: source.length, kind: "copy" }]
      : [],
  };
}

export function textRangeToSource(map: TextSourceMap, range: TextRange): TextRange[] | null {
  if (
    !isCompleteTextSourceMap(map) ||
    !validTextRange(range, map.text.length) ||
    range.start === range.end
  )
    return null;
  const ranges: TextRange[] = [];
  for (const span of map.spans) {
    const start = Math.max(range.start, span.start);
    const end = Math.min(range.end, span.end);
    if (start >= end) continue;
    if (span.kind === "insert") return null;
    ranges.push(
      span.kind === "copy"
        ? { start: span.sourceStart + start - span.start, end: span.sourceStart + end - span.start }
        : { start: span.sourceStart, end: span.sourceEnd },
    );
  }
  return mergeTextRanges(ranges);
}

export function mergeTextRanges(ranges: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous.end === range.start)
      merged[merged.length - 1] = { start: previous.start, end: range.end };
    else if (!previous || previous.start !== range.start || previous.end !== range.end)
      merged.push(range);
  }
  return merged;
}

export function sliceTextSourceMap(map: TextSourceMap, range: TextRange): TextSourceMap {
  if (!isCompleteTextSourceMap(map) || !validTextRange(range, map.text.length))
    throw new Error("Invalid source-map slice");
  return {
    source: map.source,
    text: map.text.slice(range.start, range.end),
    spans: map.spans.flatMap((span) => {
      const start = Math.max(range.start, span.start);
      const end = Math.min(range.end, span.end);
      return start >= end
        ? []
        : [
            {
              ...span,
              start: start - range.start,
              end: end - range.start,
              ...(span.kind === "copy"
                ? {
                    sourceStart: span.sourceStart + start - span.start,
                    sourceEnd: span.sourceStart + end - span.start,
                  }
                : {}),
            },
          ];
    }),
  };
}

export function applyTextSourceEdits(
  source: string,
  edits: readonly TextSourceEdit[],
): TextSourceMap {
  const spans: TextSourceSpan[] = [];
  let text = "";
  let cursor = 0;
  const copy = (end: number) => {
    if (end > cursor)
      spans.push({
        start: text.length,
        end: text.length + end - cursor,
        sourceStart: cursor,
        sourceEnd: end,
        kind: "copy",
      });
    text += source.slice(cursor, end);
    cursor = end;
  };
  for (const edit of edits) {
    if (!validTextRange(edit, source.length) || edit.start < cursor)
      throw new Error("Overlapping or invalid source edits");
    copy(edit.start);
    if (!edit.map && source.slice(edit.start, edit.end) === edit.text) {
      copy(edit.end);
      continue;
    }
    if (edit.map) {
      if (
        edit.map.source !== source.slice(edit.start, edit.end) ||
        edit.map.text !== edit.text ||
        !isCompleteTextSourceMap(edit.map)
      )
        throw new Error("Inconsistent edit source map");
      spans.push(
        ...edit.map.spans.map((span) => ({
          ...span,
          start: text.length + span.start,
          end: text.length + span.end,
          sourceStart: edit.start + span.sourceStart,
          sourceEnd: edit.start + span.sourceEnd,
        })),
      );
    } else if (edit.text.length)
      spans.push({
        start: text.length,
        end: text.length + edit.text.length,
        sourceStart: edit.start,
        sourceEnd: edit.end,
        kind: edit.start === edit.end ? "insert" : "replace",
      });
    text += edit.text;
    cursor = edit.end;
  }
  copy(source.length);
  return { source, text, spans };
}

/** `next` consumes `previous.text`; the result still refers to `previous.source`. */
export function composeTextSourceMaps(previous: TextSourceMap, next: TextSourceMap): TextSourceMap {
  if (
    previous.text !== next.source ||
    !isCompleteTextSourceMap(previous) ||
    !isCompleteTextSourceMap(next)
  )
    throw new Error("Inconsistent source-map composition");
  const spans = next.spans.flatMap((span): TextSourceSpan[] => {
    if (span.kind === "copy")
      return sliceTextSourceMap(previous, {
        start: span.sourceStart,
        end: span.sourceEnd,
      }).spans.map((part) => ({
        ...part,
        start: part.start + span.start,
        end: part.end + span.start,
      }));
    const ranges = textRangeToSource(previous, { start: span.sourceStart, end: span.sourceEnd });
    if (!ranges?.length) return [{ ...span, kind: "insert", sourceStart: 0, sourceEnd: 0 }];
    return [
      {
        ...span,
        sourceStart: ranges.reduce((min, range) => Math.min(min, range.start), Infinity),
        sourceEnd: ranges.reduce((max, range) => Math.max(max, range.end), 0),
      },
    ];
  });
  return { source: previous.source, text: next.text, spans };
}

/** Inverse projection requires every selected source unit to survive the transform. */
export function sourceRangeToText(map: TextSourceMap, range: TextRange): TextRange[] | null {
  if (
    !isCompleteTextSourceMap(map) ||
    !validTextRange(range, map.source.length) ||
    range.start === range.end
  )
    return null;
  const covered: TextRange[] = [];
  const output: TextRange[] = [];
  for (const span of map.spans) {
    const start = Math.max(range.start, span.sourceStart);
    const end = Math.min(range.end, span.sourceEnd);
    if (start >= end || span.kind === "insert") continue;
    // Generated replacements establish ownership, not character correspondence.
    if (
      span.kind === "replace" &&
      map.source.slice(span.sourceStart, span.sourceEnd).replace(/\r\n|\r/g, "\n") !==
        map.text.slice(span.start, span.end)
    )
      return null;
    covered.push({ start, end });
    output.push(
      span.kind === "copy"
        ? { start: span.start + start - span.sourceStart, end: span.start + end - span.sourceStart }
        : { start: span.start, end: span.end },
    );
  }
  let cursor = range.start;
  for (const part of covered.sort((a, b) => a.start - b.start)) {
    if (part.start > cursor) return null;
    cursor = Math.max(cursor, part.end);
  }
  return cursor === range.end ? mergeTextRanges(output) : null;
}
