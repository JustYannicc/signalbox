import { expect, it } from "vite-plus/test";
import {
  applyTextSourceEdits,
  composeTextSourceMaps,
  isCompleteTextSourceMap,
  sliceTextSourceMap,
  sourceRangeToText,
  textRangeToSource,
} from "@t3tools/shared/textSourceMap";

it("composes copied source around edits, never earlier equal text", () => {
  const first = applyTextSourceEdits("needle hidden needle", [{ start: 7, end: 14, text: "" }]);
  const second = applyTextSourceEdits(first.text, [{ start: 0, end: 0, text: "prefix " }]);
  const map = composeTextSourceMaps(first, second);
  expect(textRangeToSource(map, { start: 14, end: 20 })).toEqual([{ start: 14, end: 20 }]);
  expect(sourceRangeToText(map, { start: 14, end: 20 })).toEqual([{ start: 14, end: 20 }]);
  expect(sourceRangeToText(map, { start: 7, end: 20 })).toBeNull();
  expect(textRangeToSource(map, { start: 0, end: 1 })).toBeNull();
});

it("does not treat generated relabeling as character correspondence", () => {
  const map = applyTextSourceEdits("old", [{ start: 0, end: 3, text: "new" }]);
  expect(textRangeToSource(map, { start: 0, end: 1 })).toEqual([{ start: 0, end: 3 }]);
  expect(sourceRangeToText(map, { start: 0, end: 3 })).toBeNull();
});

it("validates coverage, edit composition and slices", () => {
  const map = applyTextSourceEdits("a\r\nb", [{ start: 1, end: 3, text: "\n" }]);
  expect(isCompleteTextSourceMap(map)).toBe(true);
  expect(sourceRangeToText(map, { start: 1, end: 3 })).toEqual([{ start: 1, end: 2 }]);
  expect(
    textRangeToSource(sliceTextSourceMap(map, { start: 1, end: 3 }), { start: 0, end: 2 }),
  ).toEqual([{ start: 1, end: 4 }]);
  expect(isCompleteTextSourceMap({ ...map, spans: map.spans.slice(1) })).toBe(false);
  expect(() => composeTextSourceMaps(map, applyTextSourceEdits("stale", []))).toThrow(
    "Inconsistent",
  );
  expect(() =>
    applyTextSourceEdits("abc", [
      { start: 1, end: 3, text: "x" },
      { start: 2, end: 3, text: "y" },
    ]),
  ).toThrow("Overlapping");
});
