import { describe, expect, it } from "vite-plus/test";

import { diffCounts, foldUnchanged, lineDiff } from "./sourceDiff.ts";

const marks = (before: string, after: string) =>
  lineDiff(before, after).map(
    (line) => `${line.kind === "same" ? " " : line.kind === "added" ? "+" : "-"}${line.text}`,
  );

describe("lineDiff", () => {
  it("shows a changed line as removed then added, keeping the rest", () => {
    expect(marks("a\nb\nc\n", "a\nB\nc\n")).toEqual([" a", "-b", "+B", " c"]);
  });

  it("finds inserted and deleted lines between shared ones", () => {
    expect(marks("one\ntwo\nthree\nfour", "zero\none\nthree\nfour\nfive")).toEqual([
      "+zero",
      " one",
      "-two",
      " three",
      " four",
      "+five",
    ]);
  });

  it("numbers lines on each side", () => {
    expect(lineDiff("x\ny", "x\nnew\ny")[1]).toEqual({
      kind: "added",
      text: "new",
      before: null,
      after: 2,
    });
    expect(diffCounts(lineDiff("x\ny", "x\nnew\ny"))).toEqual({ added: 1, removed: 0 });
  });
});

describe("foldUnchanged", () => {
  it("keeps context around changes and folds the rest into gaps", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const rows = foldUnchanged(lineDiff(before, after), 2);
    expect(rows.map((row) => (row.kind === "gap" ? `…${row.count}` : row.text))).toEqual([
      "…8",
      "line 8",
      "line 9",
      "line 10",
      "line ten",
      "line 11",
      "line 12",
      "…7",
    ]);
  });
});
