import { markdownTextSourceMap, type PositionedTextNode } from "./markdownTextSourceMap.ts";
import { textRangeToSource } from "./textSourceMap.ts";

interface MarkdownNode extends PositionedTextNode {
  readonly type: string;
  readonly value?: string;
  children?: MarkdownNode[];
}

/** remark-breaks drops text positions when it splits a node. Preserve the same split's ownership. */
export function remarkMappedBreaks() {
  return (tree: MarkdownNode, file: { readonly data: object }) => {
    const source = String(
      "threadFindOriginalMarkdown" in file.data ? file.data.threadFindOriginalMarkdown : "",
    );
    const lineStarts = [
      0,
      ...[...source.matchAll(/\r\n|\r|\n/g)].map((match) => match.index + match[0].length),
    ];
    const point = (offset: number) => {
      let low = 0;
      let high = lineStarts.length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (lineStarts[middle]! <= offset) low = middle;
        else high = middle;
      }
      return { offset, line: low + 1, column: offset - lineStarts[low]! + 1 };
    };
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value || !/[\r\n]/.test(child.value)) {
          visit(child);
          return [child];
        }
        const map = markdownTextSourceMap(source, child, child.value);
        const parts: MarkdownNode[] = [];
        const text = (start: number, end: number) => {
          if (start === end) return;
          const ranges = map ? textRangeToSource(map, { start, end }) : null;
          parts.push({
            type: "text",
            value: child.value!.slice(start, end),
            ...(ranges?.length
              ? { position: { start: point(ranges[0]!.start), end: point(ranges.at(-1)!.end) } }
              : {}),
          });
        };
        let cursor = 0;
        for (const match of child.value.matchAll(/\r?\n|\r/g)) {
          text(cursor, match.index);
          parts.push({ type: "break" });
          cursor = match.index + match[0].length;
        }
        text(cursor, child.value.length);
        return parts;
      });
    };
    visit(tree);
  };
}
