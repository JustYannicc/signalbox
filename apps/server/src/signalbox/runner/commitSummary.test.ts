import { describe, expect, it } from "@effect/vitest";

import { commitSummary, parseNameStatus, type StagedChange } from "./commitSummary.ts";

const titleOf = (changes: ReadonlyArray<StagedChange>) => commitSummary(changes).split("\n")[0];

describe("parseNameStatus", () => {
  it("reads git's -z output, renames and odd names included", () => {
    const raw = ["A", "new file.ts", "M", "src/a\nb.ts", "R087", "old.ts", "src/new.ts", ""].join(
      "\0",
    );
    expect(parseNameStatus(raw)).toEqual([
      { status: "A", path: "new file.ts" },
      { status: "M", path: "src/a\nb.ts" },
      { status: "R", from: "old.ts", path: "src/new.ts" },
    ]);
  });

  it("answers nothing for an empty diff", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("commitSummary", () => {
  it("names one file by what happened to it", () => {
    expect(commitSummary([{ status: "A", path: "src/foo.ts" }])).toBe(
      "Add foo.ts\n\nA\tsrc/foo.ts",
    );
    expect(titleOf([{ status: "M", path: "src/foo.ts" }])).toBe("Update foo.ts");
    expect(titleOf([{ status: "T", path: "src/foo.ts" }])).toBe("Update foo.ts");
    expect(titleOf([{ status: "D", path: "src/foo.ts" }])).toBe("Delete foo.ts");
    expect(commitSummary([{ status: "R", from: "src/a.ts", path: "src/b.ts" }])).toBe(
      "Rename a.ts to b.ts\n\nR\tsrc/a.ts\tsrc/b.ts",
    );
  });

  it("names a moved file by its paths, where its name alone says nothing", () => {
    expect(titleOf([{ status: "R", from: "src/a.ts", path: "lib/a.ts" }])).toBe(
      "Rename src/a.ts to lib/a.ts",
    );
  });

  it("names several files of one kind, as many as fit", () => {
    expect(
      titleOf([
        { status: "M", path: "a.ts" },
        { status: "M", path: "b.ts" },
      ]),
    ).toBe("Update a.ts and b.ts");
    expect(
      titleOf([
        { status: "M", path: "a.ts" },
        { status: "M", path: "b.ts" },
        { status: "M", path: "c.ts" },
      ]),
    ).toBe("Update a.ts, b.ts and c.ts");
    const many = Array.from({ length: 30 }, (_, i) => ({
      status: "A",
      path: `src/component-${i}.tsx`,
    }));
    const title = titleOf(many)!;
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toMatch(/^Add component-0\.tsx, component-1\.tsx.* and \d+ more files$/);
  });

  it("says files changed when they changed in different ways", () => {
    expect(
      titleOf([
        { status: "A", path: "a.ts" },
        { status: "D", path: "b.ts" },
      ]),
    ).toBe("Change a.ts and b.ts");
  });

  it("counts the files when not one name fits", () => {
    const long = "x".repeat(80);
    expect(
      titleOf([
        { status: "M", path: `${long}.ts` },
        { status: "M", path: `${long}.md` },
      ]),
    ).toBe("Update 2 files");
  });

  it("keeps a single long name's title within 72 characters", () => {
    const title = titleOf([{ status: "A", path: `${"y".repeat(100)}.ts` }])!;
    expect(title.length).toBe(72);
    expect(title.startsWith("Add yyy")).toBe(true);
  });

  it("caps the body at 50 files", () => {
    const changes = Array.from({ length: 60 }, (_, i) => ({ status: "M", path: `f${i}.ts` }));
    const body = commitSummary(changes).split("\n").slice(2);
    expect(body).toHaveLength(51);
    expect(body[0]).toBe("M\tf0.ts");
    expect(body[50]).toBe("…and 10 more");
  });

  it("writes control characters in a name out, so they can't start a new line", () => {
    const message = commitSummary([{ status: "A", path: "evil\nSigned-off-by: x.ts" }]);
    expect(message.split("\n")).toEqual([
      "Add evil\\nSigned-off-by: x.ts",
      "",
      "A\tevil\\nSigned-off-by: x.ts",
    ]);
  });

  it("still says something when nothing is staged", () => {
    expect(commitSummary([])).toBe("Save changes");
  });
});
