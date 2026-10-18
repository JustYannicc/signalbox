import { unified } from "unified";
import remarkParse from "remark-parse";
import {
  applyTextSourceEdits,
  composeTextSourceMaps,
  identityTextSourceMap,
  sliceTextSourceMap,
  type TextSourceMap,
  type TextSourceEdit,
  type TextRange,
} from "./textSourceMap.ts";

export interface PositionedTextNode {
  readonly value?: string | undefined;
  readonly position?:
    | {
        readonly start: {
          readonly offset?: number | undefined;
          readonly column?: number | undefined;
        };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
}

const entityParser = unified().use(remarkParse);
function decodeEntity(entity: string): string {
  const tree = entityParser.parse(entity);
  const paragraph = tree.children[0];
  const text = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
  return text?.type === "text" ? text.value : entity;
}

/** Decode only parser-owned tokens at their source position. Never align equal substrings. */
export function markdownTextSourceMap(
  source: string,
  node: PositionedTextNode,
  value: string,
  mode: "text" | "raw" | "inlineCode" | "code" = "text",
): TextSourceMap | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || start < 0 || end > source.length || end < start)
    return null;
  let map = sliceTextSourceMap(identityTextSourceMap(source), { start, end });
  const apply = (edits: readonly TextSourceEdit[]) => {
    map = composeTextSourceMaps(map, applyTextSourceEdits(map.text, edits));
  };
  // Continuation lines carry container markers which are absent from text callbacks.
  if (mode !== "raw") {
    const edits: TextSourceEdit[] = [];
    const indentation = (node.position?.start.column ?? 1) - 1;
    const sourceLineStart =
      Math.max(source.lastIndexOf("\n", start - 1), source.lastIndexOf("\r", start - 1)) + 1;
    const quotes = (source.slice(sourceLineStart, start).match(/>/g) ?? []).length;
    for (const match of map.text.matchAll(/(?:\r\n|\r|\n)([ \t>]*)(?=[^\r\n]|$)/g)) {
      const prefix = match[1] ?? "";
      let width = 0;
      for (let quote = 0; quote < quotes; quote += 1) {
        const marker = /^ {0,3}>[ \t]?/.exec(prefix.slice(width));
        if (!marker) break;
        width += marker[0].length;
      }
      // CommonMark discards all continuation line-prefix whitespace in prose,
      // even when it exceeds the first line's indentation. Code keeps its padding.
      const continuation =
        (mode === "text" ? /^[ \t]*/ : /^ */).exec(prefix.slice(width))?.[0].length ?? 0;
      const spaces =
        width +
        (mode === "text" ? continuation : Math.min(Math.max(0, indentation - width), continuation));
      if (spaces)
        edits.push({
          start: match.index + match[0].length - prefix.length,
          end: match.index + match[0].length - prefix.length + spaces,
          text: "",
        });
    }
    apply(edits);
  }
  if (mode === "inlineCode") {
    const ticks = /^`+/.exec(map.text)?.[0].length;
    if (!ticks || !map.text.endsWith("`".repeat(ticks))) return null;
    map = sliceTextSourceMap(map, { start: ticks, end: map.text.length - ticks });
    apply(
      [...map.text.matchAll(/\r\n|\r|\n/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: " ",
      })),
    );
    if (map.text.startsWith(" ") && map.text.endsWith(" ") && /[^ ]/.test(map.text))
      map = sliceTextSourceMap(map, { start: 1, end: map.text.length - 1 });
  } else if (mode === "code") {
    const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/.exec(map.text);
    if (opening) {
      const fence = opening[1]!;
      const closing = new RegExp(`(?:^|[\\r\\n]) {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).exec(
        map.text,
      );
      const contentEnd = closing
        ? closing.index +
          (map.text[closing.index] === "\r" && map.text[closing.index + 1] === "\n" ? 2 : 1)
        : map.text.length;
      map = sliceTextSourceMap(map, {
        start: opening[0].length,
        end: Math.max(opening[0].length, contentEnd),
      });
      const indent = /^ */.exec(opening[0])![0].length;
      if (indent)
        apply(
          [...map.text.matchAll(/^ +/gm)].map((match) => ({
            start: match.index,
            end: match.index + Math.min(indent, match[0].length),
            text: "",
          })),
        );
    } else {
      apply(
        [...map.text.matchAll(/^[ \t]+/gm)].map((match) => {
          let column = 0;
          let count = 0;
          while (count < match[0].length && column < 4) {
            column += match[0][count] === "\t" ? 4 - (column % 4) : 1;
            count += 1;
          }
          return { start: match.index, end: match.index + count, text: "" };
        }),
      );
    }
    const finalEnding = /\r\n$|\r$/.exec(map.text);
    if (finalEnding) apply([{ start: finalEnding.index, end: map.text.length, text: "\n" }]);
    if (!map.text.endsWith("\n"))
      apply([{ start: map.text.length, end: map.text.length, text: "\n" }]);
  } else if (mode !== "raw") {
    apply(
      [
        ...map.text.matchAll(
          /\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);/g,
        ),
      ].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0][0] === "\\" ? match[0].slice(1) : decodeEntity(match[0]),
      })),
    );
  }
  if (map.text !== value && /\r/.test(map.text))
    apply(
      [...map.text.matchAll(/\r\n|\r/g)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: "\n",
      })),
    );
  const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.exec(map.text);
  if (mode === "text" && alert && map.text.slice(alert[0].length) === value)
    map = sliceTextSourceMap(map, { start: alert[0].length, end: map.text.length });
  return map.text === value ? map : null;
}

export interface ThreadFindTextTree {
  readonly position?:
    | {
        readonly start: {
          readonly offset?: number | undefined;
          readonly column?: number | undefined;
        };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly type: string;
  readonly tagName?: string | undefined;
  readonly value?: string | undefined;
  readonly properties?: {
    readonly href?: unknown;
    readonly src?: unknown;
    readonly dataInlineCode?: unknown;
  };
  readonly children?: ReadonlyArray<ThreadFindTextTree> | undefined;
}

export function threadFindNodeLabelAnchor(
  markdown: string,
  node: ThreadFindTextTree,
): TextRange | null {
  const ranges: TextRange[] = [];
  const visit = (child: ThreadFindTextTree, code?: ThreadFindTextTree) => {
    if (child.type === "text") {
      const map = markdownTextSourceMap(
        markdown,
        code ?? child,
        child.value ?? "",
        code ? "inlineCode" : "text",
      );
      if (map)
        for (const span of map.spans)
          if (span.kind !== "insert") ranges.push({ start: span.sourceStart, end: span.sourceEnd });
    }
    for (const nested of child.children ?? [])
      visit(nested, child.tagName === "code" ? child : code);
  };
  visit(node);
  if (ranges.length)
    return ranges.reduce((bounds, range) => ({
      start: Math.min(bounds.start, range.start),
      end: Math.max(bounds.end, range.end),
    }));
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
}
