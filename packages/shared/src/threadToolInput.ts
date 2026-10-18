import { THREAD_TOOL_SEARCH_COMMAND_LIMIT } from "./threadSearch.ts";

const SECRET_KEY = /secret|token|password|credential|authorization|cookie|base64|image|binary/i;

export interface ThreadToolInputLeaf {
  readonly path: readonly (string | number)[];
  readonly start: number;
  readonly text: string;
}

interface ThreadToolInputText {
  readonly text: string;
  readonly leaves: readonly ThreadToolInputLeaf[];
}

function inputText(
  value: unknown,
  depth: number,
  path: readonly (string | number)[],
): ThreadToolInputText {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    const text = String(value);
    return { text, leaves: text ? [{ path, start: 0, text }] : [] };
  }
  if (typeof value !== "object" || value === null || depth >= 3) {
    return { text: "", leaves: [] };
  }
  const parts = Array.isArray(value)
    ? value.map((part, index) => inputText(part, depth + 1, [...path, index]))
    : Object.entries(value)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, part]) => inputText(part, depth + 1, [...path, key]));
  const separator = Array.isArray(value) ? " " : "\n";
  let text = "";
  const leaves: ThreadToolInputLeaf[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    if (text) text += separator;
    const start = text.length;
    text += part.text;
    leaves.push(...part.leaves.map((leaf) => ({ ...leaf, start: leaf.start + start })));
  }
  return { text, leaves };
}

/** Values and provenance use the same redaction, depth and global UTF-16 budget. */
export function threadToolInput(value: unknown): ThreadToolInputText {
  const input = inputText(value, 0, []);
  let end = Math.min(input.text.length, THREAD_TOOL_SEARCH_COMMAND_LIMIT);
  if (end < input.text.length && /[\uD800-\uDBFF]/u.test(input.text[end - 1] ?? "")) end -= 1;
  return {
    text: input.text.slice(0, end),
    leaves: input.leaves
      .filter((leaf) => leaf.start < end)
      .map((leaf) => ({ ...leaf, text: leaf.text.slice(0, end - leaf.start) })),
  };
}
