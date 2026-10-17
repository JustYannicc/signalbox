import { toolCallLines } from "@t3tools/client-runtime/work-log/item-detail";
import { threadToolInput } from "@t3tools/shared/threadToolInput";

type RenderedOffset = readonly [start: number, end: number];

interface RenderedLeaf {
  readonly path: readonly (string | number)[];
  readonly offsets: readonly RenderedOffset[];
}

// Read positions from the exact JSON we render, including escaped UTF-16 units.
function jsonLeaves(
  text: string,
  path: readonly (string | number)[],
  leafLengths: ReadonlyMap<string, number>,
): RenderedLeaf[] {
  let cursor = 0;
  const leaves: RenderedLeaf[] = [];
  const whitespace = () => {
    while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor += 1;
  };
  const stringToken = (limit = 0) => {
    const start = cursor++;
    const offsets: RenderedOffset[] = [];
    while (cursor < text.length && text[cursor] !== '"') {
      const from = cursor;
      cursor += text[cursor] === "\\" ? (text[cursor + 1] === "u" ? 6 : 2) : 1;
      if (offsets.length < limit) offsets.push([from, cursor]);
    }
    cursor += 1;
    return { start, offsets };
  };
  const visit = (currentPath: readonly (string | number)[]) => {
    whitespace();
    const limit = leafLengths.get(JSON.stringify(currentPath)) ?? 0;
    if (text[cursor] === '"') {
      const token = stringToken(limit);
      if (limit) leaves.push({ path: currentPath, offsets: token.offsets });
    } else if (text[cursor] === "{" || text[cursor] === "[") {
      const object = text[cursor++] === "{";
      const closing = object ? "}" : "]";
      whitespace();
      let index = 0;
      while (cursor < text.length && text[cursor] !== closing) {
        const token = object ? stringToken() : null;
        const key: string | number = token ? JSON.parse(text.slice(token.start, cursor)) : index++;
        if (object) {
          whitespace();
          cursor += 1;
        }
        visit([...currentPath, key]);
        whitespace();
        if (text[cursor] !== ",") break;
        cursor += 1;
        whitespace();
      }
      cursor += 1;
    } else {
      const start = cursor;
      while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor]!)) cursor += 1;
      if (limit) {
        leaves.push({
          path: currentPath,
          offsets: Array.from(
            { length: Math.min(limit, cursor - start) },
            (_, offset) => [start + offset, start + offset + 1] as const,
          ),
        });
      }
    }
  };
  visit(path);
  return leaves;
}

export function toolInputFindPresentation(value: unknown) {
  const input = threadToolInput(value);
  const leafLengths = new Map(
    input.leaves.map((leaf) => [JSON.stringify(leaf.path), leaf.text.length]),
  );
  const lines = toolCallLines({ args: value });
  const args = lines.args;
  // Output block formatting can drop input fields, such as a text block's `type`.
  const argsText = args
    ? null
    : typeof value === "string"
      ? value
      : value === undefined || value === null
        ? null
        : JSON.stringify(value, null, 2);
  const renderedLeaves: RenderedLeaf[] = [];
  let renderedLength = 0;
  const addValue = (text: string, original: unknown, path: readonly (string | number)[]) => {
    const leaves =
      typeof original === "string" && original !== ""
        ? [
            {
              path,
              offsets: Array.from(
                { length: leafLengths.get(JSON.stringify(path)) ?? 0 },
                (_, i) => [i, i + 1] as const,
              ),
            },
          ]
        : jsonLeaves(text, path, leafLengths);
    renderedLeaves.push(
      ...leaves.map((leaf) => ({
        path: leaf.path,
        offsets: leaf.offsets.map(
          ([start, end]) => [start + renderedLength, end + renderedLength] as const,
        ),
      })),
    );
    renderedLength += text.length;
  };
  if (args && typeof value === "object" && value !== null) {
    for (const [key, text] of args) {
      renderedLength += key.length + 1;
      addValue(text, Reflect.get(value, key), [key]);
    }
  } else if (argsText) {
    addValue(argsText, value, []);
  }
  const leafByPath = new Map(renderedLeaves.map((leaf) => [JSON.stringify(leaf.path), leaf]));
  const offsets: Array<RenderedOffset | null> = Array.from(
    { length: input.text.length },
    () => null,
  );
  for (const leaf of input.leaves) {
    const rendered = leafByPath.get(JSON.stringify(leaf.path));
    for (let i = 0; i < leaf.text.length; i += 1) {
      offsets[leaf.start + i] = rendered?.offsets[i] ?? null;
    }
  }
  return {
    args,
    argsText,
    attributes: {
      "data-thread-find-text": "tool-input",
      "data-thread-find-source": input.text,
      "data-thread-find-offsets": JSON.stringify(offsets),
    },
  };
}
