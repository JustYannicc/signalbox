export type TaskOutcomePart = string | { readonly label: string; readonly url: string };

const OUTCOME_LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;

function safeLinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Outcomes are one line of plain text that may carry inline `[label](url)` links, such as
 * a deploy run. Anything else, including older plain outcomes, stays verbatim; a link
 * with an unsafe scheme or unparseable URL keeps only its label.
 */
export function parseTaskOutcome(text: string): ReadonlyArray<TaskOutcomePart> {
  const parts: Array<TaskOutcomePart> = [];
  let cursor = 0;
  for (const match of text.matchAll(OUTCOME_LINK)) {
    const [whole, label = "", rawUrl = ""] = match;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const url = safeLinkUrl(rawUrl);
    parts.push(url ? { label, url } : label);
    cursor = match.index + whole.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
