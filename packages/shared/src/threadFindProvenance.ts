import {
  isCompleteTextSourceMap,
  mergeTextRanges,
  textRangeToSource,
  validTextRange,
  type TextRange,
  type TextSourceMap,
} from "./textSourceMap.ts";

export interface ThreadFindDisplaySlot {
  readonly kind: "link-label" | "plan-title" | "artifact-name" | "artifact-kind" | "empty-response";
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly text: string;
  readonly href?: string;
}

export interface ThreadFindProvenanceRun extends TextRange {
  readonly target:
    | {
        readonly kind: "source";
        readonly sourceStart: number;
        readonly sourceEnd: number;
        readonly atomic: boolean;
      }
    | {
        readonly kind: "slot";
        readonly slot: ThreadFindDisplaySlot;
        readonly start: number;
        readonly end: number;
      }
    | { readonly kind: "unmapped" };
}

export interface ThreadFindSegment {
  readonly text: string;
  readonly runs: readonly ThreadFindProvenanceRun[];
}

export interface ThreadFindDocument {
  readonly source: string;
  readonly segments: readonly ThreadFindSegment[];
}

export interface ThreadFindResolvedRange {
  readonly ranges: readonly TextRange[];
  readonly slots: readonly {
    readonly slot: ThreadFindDisplaySlot;
    readonly start: number;
    readonly end: number;
  }[];
}

export function resolveThreadFindRange(
  document: ThreadFindDocument,
  segmentIndex: number,
  range: TextRange,
): ThreadFindResolvedRange | null {
  const segment = document.segments[segmentIndex];
  const scalarBoundary = (offset: number) =>
    !/[\uD800-\uDBFF]/u.test(segment?.text[offset - 1] ?? "") ||
    !/[\uDC00-\uDFFF]/u.test(segment?.text[offset] ?? "");
  if (
    !segment ||
    !validTextRange(range, segment.text.length) ||
    range.start === range.end ||
    !scalarBoundary(range.start) ||
    !scalarBoundary(range.end)
  )
    return null;
  const ranges: TextRange[] = [];
  const slots: { slot: ThreadFindDisplaySlot; start: number; end: number }[] = [];
  let cursor = 0;
  for (const run of segment.runs) {
    if (!validTextRange(run, segment.text.length) || run.start !== cursor || run.end === cursor)
      return null;
    cursor = run.end;
    const start = Math.max(run.start, range.start);
    const end = Math.min(run.end, range.end);
    const target = run.target;
    if (target.kind === "source") {
      if (
        !validTextRange(
          { start: target.sourceStart, end: target.sourceEnd },
          document.source.length,
        ) ||
        target.sourceStart === target.sourceEnd ||
        (!target.atomic &&
          (target.sourceEnd - target.sourceStart !== run.end - run.start ||
            document.source.slice(target.sourceStart, target.sourceEnd) !==
              segment.text.slice(run.start, run.end)))
      )
        return null;
      if (start < end)
        ranges.push(
          target.atomic
            ? { start: target.sourceStart, end: target.sourceEnd }
            : {
                start: target.sourceStart + start - run.start,
                end: target.sourceStart + end - run.start,
              },
        );
    } else if (target.kind === "slot") {
      if (
        !validTextRange(target, target.slot.text.length) ||
        target.end - target.start !== run.end - run.start ||
        target.slot.text.slice(target.start, target.end) !==
          segment.text.slice(run.start, run.end) ||
        !validTextRange(
          { start: target.slot.sourceStart, end: target.slot.sourceEnd },
          document.source.length,
        )
      )
        return null;
      if (start < end)
        slots.push({
          slot: target.slot,
          start: target.start + start - run.start,
          end: target.start + end - run.start,
        });
    } else if (start < end) return null;
  }
  return cursor === segment.text.length ? { ranges: mergeTextRanges(ranges), slots } : null;
}

export function remapThreadFindDocument(
  document: ThreadFindDocument,
  map: TextSourceMap,
): ThreadFindDocument {
  if (map.text !== document.source || !isCompleteTextSourceMap(map))
    throw new Error("Inconsistent semantic source map");
  return {
    source: map.source,
    segments: document.segments.map((segment) => ({
      text: segment.text,
      runs: segment.runs.flatMap((run): ThreadFindProvenanceRun[] => {
        const target = run.target;
        if (target.kind === "unmapped") return [run];
        const start = target.kind === "slot" ? target.slot.sourceStart : target.sourceStart;
        const end = target.kind === "slot" ? target.slot.sourceEnd : target.sourceEnd;
        const ranges = textRangeToSource(map, { start, end });
        if (!ranges?.length) return [{ ...run, target: { kind: "unmapped" } }];
        if (target.kind === "slot") {
          return [
            {
              ...run,
              target: {
                ...target,
                slot: {
                  ...target.slot,
                  sourceStart: ranges[0]!.start,
                  sourceEnd: ranges.at(-1)!.end,
                },
              },
            },
          ];
        }
        if (target.atomic)
          return [
            {
              ...run,
              target: { ...target, sourceStart: ranges[0]!.start, sourceEnd: ranges.at(-1)!.end },
            },
          ];
        return map.spans.flatMap((span) => {
          const from = Math.max(start, span.start);
          const to = Math.min(end, span.end);
          if (from >= to) return [];
          return [
            {
              start: run.start + from - start,
              end: run.start + to - start,
              target:
                span.kind === "insert"
                  ? { kind: "unmapped" }
                  : {
                      kind: "source",
                      sourceStart:
                        span.kind === "copy"
                          ? span.sourceStart + from - span.start
                          : span.sourceStart,
                      sourceEnd:
                        span.kind === "copy" ? span.sourceStart + to - span.start : span.sourceEnd,
                      atomic: span.kind !== "copy",
                    },
            },
          ];
        });
      }),
    })),
  };
}
