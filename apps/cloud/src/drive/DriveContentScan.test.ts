import { describe, expect, it } from "@effect/vitest";
import { EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { DriveContentScanState, scanDriveContents } from "./DriveContentScan.ts";
import type { DriveReader } from "./DriveReader.ts";
type Bytes = Effect.Success<ReturnType<DriveReader["blob"]>>;
type TreeEntry = Effect.Success<ReturnType<DriveReader["tree"]>>[number];
type TreeEntryKind = TreeEntry["kind"];

const encoder = new TextEncoder();
const input = {
  query: "needle",
  limit: 500,
  caseSensitive: true,
  wholeWord: false,
  useRegex: false,
};
type FixtureFile =
  | string
  | {
      readonly contents: string | Bytes;
      readonly kind?: TreeEntryKind;
      readonly size?: number | null;
    };

function fixture(files: Record<string, FixtureFile>) {
  const trees = new Map<string, TreeEntry[]>([["root", []]]);
  const blobs = new Map<string, Bytes>();
  const sizes = new Map<string, number | null>();
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split("/");
    let tree = "root";
    for (const part of parts.slice(0, -1)) {
      const child = `${tree}/${part}`;
      if (!trees.has(child)) {
        trees.set(child, []);
        trees.get(tree)!.push({ name: part, kind: "directory", mode: "40000", oid: child });
      }
      tree = child;
    }
    const file = typeof value === "string" ? { contents: value } : value;
    const oid = `blob:${path}`;
    const bytes = typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents;
    blobs.set(oid, bytes);
    sizes.set(oid, file.size === undefined ? bytes.length : file.size);
    trees.get(tree)!.push({ name: parts.at(-1)!, kind: file.kind ?? "file", mode: "100644", oid });
  }
  for (const [oid, entries] of trees)
    sizes.set(
      oid,
      Math.max(
        1,
        entries.reduce((total, entry) => total + entry.name.length + 22, 0),
      ),
    );
  const reader = {
    treeOf: vi.fn((_commit: string | null) => Effect.succeed("root")),
    tree: vi.fn((oid: string) => Effect.succeed(trees.get(oid) ?? [])),
    blob: vi.fn((oid: string) => Effect.succeed(blobs.get(oid)!)),
    sizes: vi.fn((oids: ReadonlyArray<string>) =>
      Effect.succeed(new Map(oids.map((oid) => [oid, sizes.get(oid) ?? null]))),
    ),
  } satisfies Pick<DriveReader, "treeOf" | "tree" | "blob" | "sizes">;
  return { reader, blobs, sizes };
}

const decodeState = Schema.decodeSync(Schema.fromJsonString(DriveContentScanState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(DriveContentScanState));
const roundTrip = (state: DriveContentScanState) => decodeState(encodeState(state));

describe("immutable drive content pages", () => {
  it.effect("reads an empty drive without requiring a stored empty-tree object", () =>
    Effect.gen(function* () {
      const { reader } = fixture({});
      reader.treeOf.mockReturnValue(Effect.succeed(EMPTY_TREE));
      const result = yield* scanDriveContents(reader, null, input);
      expect(result).toEqual({ matches: [], truncated: false });
      expect(reader.sizes).not.toHaveBeenCalled();
    }),
  );

  it.effect("returns overlapping literal ranges as UTF-16 offsets and preserves whitespace", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "notes.txt": "😀 banana\r\n foo \n" });
      const result = yield* scanDriveContents(reader, "commit", { ...input, query: "ana" });
      expect(result.matches).toEqual([
        {
          path: "notes.txt",
          lineNumber: 1,
          lineContent: "😀 banana",
          matchRanges: [
            { start: 4, end: 7 },
            { start: 6, end: 9 },
          ],
        },
      ]);
      const spaces = yield* scanDriveContents(reader, "commit", { ...input, query: " foo " });
      expect(spaces.matches[0]?.matchRanges).toEqual([{ start: 0, end: 5 }]);
    }),
  );

  it.effect("uses Unicode whole-word boundaries and punctuation-edged queries", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "words.txt": "𐐀foo foo foo𐐀 foo_ foó\n-foo- -foo-\n" });
      const words = yield* scanDriveContents(reader, "commit", {
        ...input,
        query: "foo",
        wholeWord: true,
      });
      expect(words.matches[0]?.matchRanges).toEqual([{ start: 6, end: 9 }]);
      expect(words.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      const punctuation = yield* scanDriveContents(reader, "commit", {
        ...input,
        query: "-foo-",
        wholeWord: true,
      });
      expect(punctuation.matches[0]?.matchRanges).toEqual([
        { start: 0, end: 5 },
        { start: 6, end: 11 },
      ]);
    }),
  );

  it.effect(
    "matches native multiline literal and regex examples with only the first line highlighted",
    () =>
      Effect.gen(function* () {
        const { reader } = fixture({
          "multi.txt": "hello unicorn\nrainbow world\n",
          "noise.txt": "unicorn\nno rainbow here\n",
        });
        for (const useRegex of [false, true]) {
          for (const query of ["unicorn\\nrainbow", "unicorn\nrainbow"]) {
            const result = yield* scanDriveContents(reader, "commit", {
              ...input,
              query,
              useRegex,
            });
            expect(result.matches).toEqual([
              {
                path: "multi.txt",
                lineNumber: 1,
                lineContent: "hello unicorn",
                matchRanges: [{ start: 6, end: 13 }],
              },
            ]);
          }
        }
      }),
  );

  it.effect("keeps escaped backslash-newline text literal in plain queries", () =>
    Effect.gen(function* () {
      const { reader } = fixture({
        "winpath.txt": String.raw`let p = "C:\\Users\\nvim-data";`,
        "newline.txt": "Users\nnvim-data",
      });
      const result = yield* scanDriveContents(reader, "commit", {
        ...input,
        query: String.raw`\\nvim-data`,
      });
      expect(result.matches.map((match) => match.path)).toEqual(["winpath.txt"]);
      expect(
        result.matches[0]!.lineContent.slice(
          result.matches[0]!.matchRanges[0]!.start,
          result.matches[0]!.matchRanges[0]!.end,
        ),
      ).toBe(String.raw`\\nvim-data`);
    }),
  );

  it.effect("supports whole-file regex spans and multiline anchors", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "multi.txt": "noise\nhello unicorn\nrainbow world\n" });
      const span = yield* scanDriveContents(reader, "commit", {
        ...input,
        query: "(?s)unicorn.*?rainbow",
        useRegex: true,
      });
      expect(span.matches).toEqual([
        {
          path: "multi.txt",
          lineNumber: 2,
          lineContent: "hello unicorn",
          matchRanges: [{ start: 6, end: 13 }],
        },
      ]);
      const anchor = yield* scanDriveContents(reader, "commit", {
        ...input,
        query: "^hello unicorn$",
        useRegex: true,
      });
      expect(anchor.matches.map((match) => match.lineNumber)).toEqual([2]);
    }),
  );

  it.effect("resumes multiline regex spans after their consumed text across persisted pages", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "multi.txt": "foo\nfoo\nfoo\nfoo\nfoo\nfoo\n" });
      const query = { ...input, query: "foo\\nfoo", useRegex: true, limit: 1 };
      let state: DriveContentScanState | null = null;
      const lines: number[] = [];
      for (let page = 0; page < 6; page++) {
        const result = yield* scanDriveContents(reader, "commit", query, state);
        lines.push(...result.matches.map((match) => match.lineNumber));
        if (result.nextState === undefined) break;
        state = roundTrip(result.nextState);
      }
      expect(lines).toEqual([1, 3, 5]);
      expect(reader.treeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps literal newline overlaps when continuing inside a file", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "multi.txt": "foo\nfoo\nfoo\nfoo\n" });
      const query = { ...input, query: "foo\\nfoo", limit: 1 };
      let state: DriveContentScanState | null = null;
      const lines: number[] = [];
      for (let page = 0; page < 6; page++) {
        const result = yield* scanDriveContents(reader, "commit", query, state);
        lines.push(...result.matches.map((match) => match.lineNumber));
        if (result.nextState === undefined) break;
        state = roundTrip(result.nextState);
      }
      expect(lines).toEqual([1, 2, 3]);
    }),
  );

  it.effect(
    "matches RE2 expressions without rewriting escapes and falls back to literal invalid expressions",
    () =>
      Effect.gen(function* () {
        const { reader } = fixture({ "shapes.txt": "Square\nsquare\nfoo)bar(\n" });
        const regex = yield* scanDriveContents(reader, "commit", {
          ...input,
          query: "\\SQUARE",
          caseSensitive: false,
          useRegex: true,
        });
        expect(regex.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
        const invalid = yield* scanDriveContents(reader, "commit", {
          ...input,
          query: "foo)bar(",
          useRegex: true,
        });
        expect(invalid.regexFallbackError).toBeDefined();
        expect(invalid.matches.map((match) => match.lineNumber)).toEqual([3]);
      }),
  );

  it.effect("evaluates regex anchors against the complete line before clipping its snippet", () =>
    Effect.gen(function* () {
      const { reader } = fixture({
        "long.txt": `${"x".repeat(506)}needle${"x".repeat(10)}needle\n`,
      });
      const result = yield* scanDriveContents(reader, "commit", {
        ...input,
        query: "needle$",
        useRegex: true,
      });
      expect(result.matches).toEqual([]);
    }),
  );

  it.effect("resumes inside files after JSON persistence and pins the original commit", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "dense.txt": "needle\n".repeat(5), "later.txt": "needle\n" });
      const first = yield* scanDriveContents(reader, "old", { ...input, limit: 2 });
      const original = JSON.stringify(first.nextState);
      const second = yield* scanDriveContents(
        reader,
        "new",
        { ...input, limit: 2 },
        roundTrip(first.nextState!),
      );
      const third = yield* scanDriveContents(
        reader,
        "new",
        { ...input, limit: 2 },
        roundTrip(second.nextState!),
      );
      expect(
        [...first.matches, ...second.matches, ...third.matches].map((match) => [
          match.path,
          match.lineNumber,
        ]),
      ).toEqual([
        ["dense.txt", 1],
        ["dense.txt", 2],
        ["dense.txt", 3],
        ["dense.txt", 4],
        ["dense.txt", 5],
        ["later.txt", 1],
      ]);
      expect(second.nextState?.commit).toBe("old");
      expect(reader.treeOf).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(first.nextState)).toBe(original);
    }),
  );

  it.effect("continues empty bounded pages until a late matching file", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "a.txt": "no", "b.txt": "no", "nested/late.txt": "needle" });
      let state: DriveContentScanState | null = null;
      const matches = [];
      for (let page = 0; page < 12; page++) {
        const result = yield* scanDriveContents(reader, "commit", input, state, { entries: 1 });
        matches.push(...result.matches);
        if (result.nextState === undefined) {
          expect(result.truncated).toBe(false);
          break;
        }
        expect(result.truncated).toBe(true);
        state = roundTrip(result.nextState);
      }
      expect(matches.map((match) => match.path)).toEqual(["nested/late.txt"]);
      expect(reader.treeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("finds files beyond 25,000 entries without restarting the tree walk", () =>
    Effect.gen(function* () {
      const files = Object.fromEntries(
        Array.from({ length: 25_010 }, (_, index) => [
          `file-${index}.txt`,
          index === 25_009 ? "needle" : "other",
        ]),
      );
      const { reader } = fixture(files);
      let state: DriveContentScanState | null = null;
      const found: string[] = [];
      let complete = false;
      for (let page = 0; page < 30; page++) {
        const result = yield* scanDriveContents(reader, "commit", input, state, { entries: 2_000 });
        found.push(...result.matches.map((match) => match.path));
        if (result.nextState === undefined) {
          complete = true;
          break;
        }
        state = roundTrip(result.nextState);
      }
      expect(complete).toBe(true);
      expect(found).toEqual(["file-25009.txt"]);
      expect(reader.treeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("counts trees in the byte budget and resumes without skipping deferred blobs", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "a.txt": "needle", "b.txt": "needle" });
      const first = yield* scanDriveContents(reader, "commit", input, null, { bytes: 60 });
      expect(first.matches.map((match) => match.path)).toEqual(["a.txt"]);
      expect(reader.blob).toHaveBeenCalledTimes(1);
      const second = yield* scanDriveContents(reader, "commit", input, first.nextState!, {
        bytes: 60,
      });
      expect(second.matches.map((match) => match.path)).toEqual(["b.txt"]);
      expect(second.nextState).toBeUndefined();
    }),
  );

  it.effect("makes progress when a whole eligible file fills the byte budget", () =>
    Effect.gen(function* () {
      const maximum = 10 * 1024 * 1024;
      const { reader } = fixture({ "large.txt": `needle${"x".repeat(maximum - 6)}` });
      const first = yield* scanDriveContents(reader, "commit", input, null, { bytes: maximum });
      expect(first.matches).toEqual([]);
      expect(first.nextState?.file?.path).toBe("large.txt");
      const second = yield* scanDriveContents(
        reader,
        "commit",
        input,
        roundTrip(first.nextState!),
        { bytes: maximum },
      );
      expect(second.matches.map((match) => match.path)).toEqual(["large.txt"]);
      const third = yield* scanDriveContents(
        reader,
        "commit",
        input,
        roundTrip(second.nextState!),
        { bytes: maximum },
      );
      expect(third.nextState).toBeUndefined();
    }),
  );

  it.effect("saves ignore object ids before deferring their reads behind a full tree budget", () =>
    Effect.gen(function* () {
      const { reader, sizes } = fixture({ ".gitignore": "skip\n", "keep.txt": "needle" });
      const byteLimit = sizes.get("root")!;
      let state: DriveContentScanState | null = null;
      const paths: string[] = [];
      let complete = false;
      for (let page = 0; page < 10; page++) {
        const result = yield* scanDriveContents(reader, "commit", input, state, {
          bytes: byteLimit!,
        });
        paths.push(...result.matches.map((match) => match.path));
        if (result.nextState === undefined) {
          complete = true;
          break;
        }
        state = roundTrip(result.nextState);
      }
      expect(complete).toBe(true);
      expect(paths).toEqual(["keep.txt"]);
      expect(reader.treeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("honors nested ignore rules, .ignore precedence, negation, and directory pruning", () =>
    Effect.gen(function* () {
      const { reader } = fixture({
        ".gitignore": "*.log\nblocked/\n*.txt\n",
        ".ignore": "!keep.txt\nprotected.txt\n",
        "keep.txt": "needle",
        "skip.txt": "needle",
        "skip.log": "needle",
        "blocked/.gitignore": "!file.txt\n",
        "blocked/file.txt": "needle",
        "nested/.gitignore": "!*.txt\n",
        "nested/.ignore": "private.txt\n",
        "nested/open.txt": "needle",
        "nested/private.txt": "needle",
        "nested/protected.txt": "needle",
      });
      const result = yield* scanDriveContents(reader, "commit", input);
      expect(result.matches.map((match) => match.path)).toEqual([
        "keep.txt",
        "nested/open.txt",
        "nested/protected.txt",
      ]);
      expect(reader.blob.mock.calls.map(([oid]) => oid)).not.toContain("blob:blocked/.gitignore");
      expect(result.truncated).toBe(false);
    }),
  );

  it.effect("lets the nearest ignore scope override an ancestor's .ignore rules", () =>
    Effect.gen(function* () {
      for (const included of [true, false]) {
        const { reader } = fixture({
          ".ignore": `${included ? "" : "!"}protected.txt\n`,
          "nested/.gitignore": `${included ? "!" : ""}protected.txt\n`,
          "nested/protected.txt": "needle",
        });
        const result = yield* scanDriveContents(reader, "commit", input);
        expect(result.matches.map((match) => match.path)).toEqual(
          included ? ["nested/protected.txt"] : [],
        );
      }
    }),
  );

  it.effect("keeps admitted parents open when resolving a child's direct ignore rules", () =>
    Effect.gen(function* () {
      for (const name of ["folder", "folder [a]*?#!\\"]) {
        const { reader } = fixture({
          ".gitignore": "folder*/\n*.log\n",
          "nested/.gitignore": "!folder*/\n",
          [`nested/${name}/keep.txt`]: "needle",
          [`nested/${name}/skip.log`]: "needle",
        });
        const result = yield* scanDriveContents(reader, "commit", input);
        expect(result.matches.map((match) => match.path)).toEqual([`nested/${name}/keep.txt`]);
        expect(reader.blob.mock.calls.map(([oid]) => oid)).not.toContain(
          `blob:nested/${name}/skip.log`,
        );
      }
    }),
  );

  it.effect(
    "excludes binary, oversized, symlink and submodule content without fetching oversized objects",
    () =>
      Effect.gen(function* () {
        const { reader } = fixture({
          "binary.txt": `${"x".repeat(9000)}\0needle`,
          "huge.txt": { contents: "needle", size: 10 * 1024 * 1024 + 1 },
          link: { contents: "needle", kind: "symlink" },
          module: { contents: "needle", kind: "submodule" },
          "needle.jpg": "needle",
          "regular.txt": "needle",
        });
        const result = yield* scanDriveContents(reader, "commit", input);
        expect(result.matches.map((match) => match.path)).toEqual(["regular.txt"]);
        expect(reader.blob.mock.calls.map(([oid]) => oid)).toEqual([
          "blob:binary.txt",
          "blob:regular.txt",
        ]);
        expect(result.truncated).toBe(false);
      }),
  );

  it.effect("includes hidden Git files unless their ignore rules exclude them", () =>
    Effect.gen(function* () {
      const { reader } = fixture({
        ".gitignore": "# needle\n",
        ".ignore": "# needle\n",
        ".notes": "needle",
        ".hidden/file.txt": "needle",
      });
      const result = yield* scanDriveContents(reader, "commit", input);
      expect(result.matches.map((match) => match.path)).toEqual([
        ".gitignore",
        ".ignore",
        ".notes",
        ".hidden/file.txt",
      ]);
    }),
  );

  it.effect("keeps truncation honest after the per-file cap and unknown object sizes", () =>
    Effect.gen(function* () {
      const { reader } = fixture({
        "dense.txt": "needle\n".repeat(101),
        "unknown.txt": { contents: "needle", size: null },
        "other.txt": "needle",
      });
      const result = yield* scanDriveContents(reader, "commit", input);
      expect(result.matches.filter((match) => match.path === "dense.txt")).toHaveLength(100);
      expect(result.matches.at(-1)?.path).toBe("other.txt");
      expect(result.truncated).toBe(true);
      expect(result.nextState).toBeUndefined();
      expect(reader.blob.mock.calls.map(([oid]) => oid)).not.toContain("blob:unknown.txt");
      const first = yield* scanDriveContents(reader, "commit", { ...input, limit: 60 });
      const second = yield* scanDriveContents(
        reader,
        "commit",
        { ...input, limit: 60 },
        roundTrip(first.nextState!),
      );
      expect(
        [...first.matches, ...second.matches].filter((match) => match.path === "dense.txt"),
      ).toHaveLength(100);
      expect(second.truncated).toBe(true);
    }),
  );

  it.effect(
    "limits snippets to UTF-8 bytes without splitting characters and keeps full-line word boundaries",
    () =>
      Effect.gen(function* () {
        const { reader } = fixture({
          "unicode.txt": `${"é".repeat(253)} fooBar\n${"x".repeat(513)}needle\n`,
        });
        const partial = yield* scanDriveContents(reader, "commit", { ...input, query: "foo" });
        expect(encoder.encode(partial.matches[0]!.lineContent).length).toBe(512);
        expect(partial.matches[0]?.matchRanges).toEqual([{ start: 254, end: 257 }]);
        const word = yield* scanDriveContents(reader, "commit", {
          ...input,
          query: "foo",
          wholeWord: true,
        });
        expect(word.matches).toEqual([]);
        const beyond = yield* scanDriveContents(reader, "commit", input);
        expect(beyond.matches).toEqual([]);
      }),
  );

  it.effect("prunes excluded shortcut paths before reading blobs", () =>
    Effect.gen(function* () {
      const { reader } = fixture({
        "shared/hidden.txt": "needle",
        "same.txt": "needle",
        "keep.txt": "needle",
      });
      const result = yield* scanDriveContents(reader, "commit", input, null, {
        excludePaths: ["shared", "same.txt"],
      });
      expect(result.matches.map((match) => match.path)).toEqual(["keep.txt"]);
      expect(reader.blob.mock.calls.map(([oid]) => oid)).toEqual(["blob:keep.txt"]);
    }),
  );

  it.effect("rejects ignore rules it cannot read within its bounds", () =>
    Effect.gen(function* () {
      for (const size of [null, 64 * 1024 + 1]) {
        const { reader } = fixture({
          ".gitignore": { contents: "secret/", size },
          "secret/file.txt": "needle",
        });
        const error = yield* Effect.flip(scanDriveContents(reader, "commit", input));
        expect(error._tag).toBe("DriveReadError");
        expect(reader.blob).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect("rejects directory trees with unknown or excessive sizes before reading them", () =>
    Effect.gen(function* () {
      for (const size of [null, 10 * 1024 * 1024 + 1]) {
        const { reader, sizes } = fixture({ "file.txt": "needle" });
        sizes.set("root", size);
        const error = yield* Effect.flip(scanDriveContents(reader, "commit", input));
        expect(error._tag).toBe("DriveReadError");
        expect(reader.tree).not.toHaveBeenCalled();
      }
    }),
  );
});
