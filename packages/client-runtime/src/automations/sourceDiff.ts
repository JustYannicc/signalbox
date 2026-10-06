import { diffLines } from "diff";

/**
 * A line diff between an automation's live source and its draft, for the
 * "what changes if I publish" view on web and mobile.
 */

export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
  /** Line number in the live source; null for added lines. */
  readonly before: number | null;
  /** Line number in the draft; null for removed lines. */
  readonly after: number | null;
}

/** Unchanged lines folded away between changes. */
export interface DiffGap {
  readonly kind: "gap";
  /** Where the folded lines start in the full diff, which also keys the gap. */
  readonly from: number;
  readonly count: number;
}

export type DiffRow = DiffLine | DiffGap;

/** Past this many edits the diff gives up and the whole file shows as replaced. */
const MAX_EDITS = 2_000;

const splitLines = (source: string) => source.replace(/\n$/, "").split("\n");

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Every line ends in a newline, so a missing one at the end of a file isn't a change.
  const changes = diffLines(`${a.join("\n")}\n`, `${b.join("\n")}\n`, {
    maxEditLength: MAX_EDITS,
  }) ?? [
    { value: `${a.join("\n")}\n`, removed: true, added: false },
    { value: `${b.join("\n")}\n`, removed: false, added: true },
  ];
  const lines: DiffLine[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const change of changes) {
    for (const text of change.value.replace(/\n$/, "").split("\n")) {
      if (change.added) lines.push({ kind: "added", text, before: null, after: ++afterLine });
      else if (change.removed)
        lines.push({ kind: "removed", text, before: ++beforeLine, after: null });
      else lines.push({ kind: "same", text, before: ++beforeLine, after: ++afterLine });
    }
  }
  return lines;
}

/** Folds runs of unchanged lines down to `context` lines around each change. */
export function foldUnchanged(lines: ReadonlyArray<DiffLine>, context = 3): DiffRow[] {
  const near = Array.from({ length: lines.length }, () => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let at = from; at <= to; at++) near[at] = true;
  });
  const rows: DiffRow[] = [];
  let hidden = 0;
  lines.forEach((line, index) => {
    if (near[index]) {
      if (hidden > 0) rows.push({ kind: "gap", from: index - hidden, count: hidden });
      hidden = 0;
      rows.push(line);
    } else {
      hidden++;
    }
  });
  if (hidden > 0) rows.push({ kind: "gap", from: lines.length - hidden, count: hidden });
  return rows;
}

export function diffCounts(lines: ReadonlyArray<DiffLine>) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}
