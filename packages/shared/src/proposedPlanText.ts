import {
  applyTextSourceEdits,
  composeTextSourceMaps,
  sliceTextSourceMap,
  identityTextSourceMap,
  type TextSourceMap,
} from "./textSourceMap.ts";
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

// signalbox: ordinary text and source maps share the displayed-body boundary policy.
function displayedPlanBodyLine(lines: readonly string[]): number {
  let index = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? 1 : 0;
  while (lines[index]?.trim().length === 0) index += 1;
  const firstHeadingMatch = lines[index]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    index += 1;
    while (lines[index]?.trim().length === 0) index += 1;
  }
  return index;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  return lines.slice(displayedPlanBodyLine(lines)).join("\n");
}

// signalbox: Find offsets still refer to the original plan after headings and CRLF are stripped.
export function stripDisplayedPlanWithSourceMap(source: string): TextSourceMap {
  const normalized = applyTextSourceEdits(
    source,
    [...source.matchAll(/\r\n/g)].map((match) => ({
      start: match.index,
      end: match.index + 2,
      text: "\n",
    })),
  );
  const trimmed = normalized.text.trimEnd();
  const lines = trimmed.split("\n");
  const start = lines
    .slice(0, displayedPlanBodyLine(lines))
    .reduce((offset, line) => offset + line.length + 1, 0);
  const stripped = sliceTextSourceMap(identityTextSourceMap(normalized.text), {
    start: Math.min(start, trimmed.length),
    end: trimmed.length,
  });
  return composeTextSourceMaps(normalized, stripped);
}
