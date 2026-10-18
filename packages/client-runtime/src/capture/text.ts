/**
 * Quick capture's `#folder` grammar. Typing `#` opens folder suggestions;
 * picking one swaps the typed `#query` for a chip, so the draft's prompt never
 * carries the tag (a prompt ending in `#x` would open the composer's
 * pull-request menu).
 */
import { ellipsize } from "@t3tools/shared/String";

export interface ActiveFolderTrigger {
  readonly query: string;
  /** Index of the `#`. */
  readonly start: number;
  readonly end: number;
}

const TRIGGER_PATTERN = /(^|\s)#([^\s#]*)$/;

/** The `#query` the caret sits in, if any. */
export function findFolderTrigger(text: string, caret: number): ActiveFolderTrigger | null {
  const match = TRIGGER_PATTERN.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? "";
  return { query, start: caret - query.length - 1, end: caret };
}

/** Drops the typed `#query` once it became a chip, and where the caret goes. */
export function removeTriggerText(
  text: string,
  trigger: ActiveFolderTrigger,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const rest = text.slice(trigger.end);
  const after = before === "" || /\s$/.test(before) ? rest.replace(/^ /, "") : rest;
  return { text: before + after, caret: before.length };
}

/** Prefix matches on any path segment first, then substring matches; an empty query keeps order. */
export function rankByLabel<T extends { readonly label: string }>(
  candidates: ReadonlyArray<T>,
  query: string,
  limit: number,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return candidates.slice(0, limit);
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const candidate of candidates) {
    const label = candidate.label.toLowerCase();
    if (label.split(" / ").some((segment) => segment.startsWith(needle))) prefix.push(candidate);
    else if (label.includes(needle)) contains.push(candidate);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** mod+Enter: open the capture as a full draft. */
export function isOpenDraftShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  isMac: boolean,
): boolean {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.shiftKey && event.key === "Enter";
}

/** "Fix the login redirect", from the first line, for the saved toast. */
export function captureTitle(text: string, maxLength = 60): string {
  return ellipsize(text.trim().split("\n", 1)[0]?.trim() ?? "", maxLength);
}
