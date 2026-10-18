import { expect, it } from "vite-plus/test";
import {
  nativeMarkdownSourceMap,
  markdownWithHtmlSourceMap,
  markdownWithTableBreaksSourceMap,
} from "./markdownDocument";
import { sourceRangeToText, textRangeToSource } from "@t3tools/shared/textSourceMap";

it("preserves source ownership through HTML removal and CRLF table-break insertion", () => {
  const source =
    "<details>\r\n<summary>needle &amp; 😀</summary>\r\n\r\nIntro\r\n| a | needle |\r\n| - | - |\r\n| c | d |\r\n</details>";
  const map = nativeMarkdownSourceMap(source);
  const start = source.lastIndexOf("needle");
  const projected = sourceRangeToText(map, { start, end: start + 6 });
  expect(projected).toHaveLength(1);
  expect(map.text.slice(projected![0]!.start, projected![0]!.end)).toBe("needle");
  expect(textRangeToSource(map, projected![0]!)).toEqual([{ start, end: start + 6 }]);
  expect(map.text).toContain("Intro\r\n\r\n| a | needle |");
});

it("keeps lazy table header cells copied while generating container markers", () => {
  const source = "> Intro\n| a | needle |\n> | - | - |\n> | c | d |";
  const map = markdownWithTableBreaksSourceMap(source);
  const start = source.indexOf("needle");
  const ranges = sourceRangeToText(map, { start, end: start + 6 });
  expect(ranges?.map((range) => map.text.slice(range.start, range.end))).toEqual(["needle"]);
  expect(textRangeToSource(map, { start: 8, end: 9 })).toBeNull();
});

it("leaves literal HTML inside code mapped to itself", () => {
  const source = '<details>\n\n```html\n<img alt="needle" src="literal.png">\n```\n</details>';
  const map = markdownWithHtmlSourceMap(source);
  const start = source.indexOf("needle");
  expect(
    sourceRangeToText(map, { start, end: start + 6 })?.map((range) =>
      map.text.slice(range.start, range.end),
    ),
  ).toEqual(["needle"]);
});
