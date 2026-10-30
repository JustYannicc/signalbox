import { describe, expect, it } from "@effect/vitest";
import { EMPTY_TREE } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import {
  DriveContentScanState,
  scanDriveContents,
  type DriveContentScanBudget,
} from "./DriveContentScan.ts";
import type { DriveReader } from "./DriveReader.ts";
import type { MetadataState } from "./DriveMetadata.ts";
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

const fixtureId = (index: number) => index.toString(16).padStart(40, "0");

function metadataFixture(
  objects: ReadonlyMap<string, { readonly bytes: Bytes; readonly kind: "tree" | "blob" }>,
  root: string,
  aliases: ReadonlyMap<string, string>,
  sizes = new Map<string, number | null>(
    [...objects].map(([oid, object]) => [oid, object.bytes.length]),
  ),
) {
  const state = (oid: string): MetadataState | null => {
    const object = objects.get(oid);
    return object === undefined
      ? null
      : {
          oid,
          formatVersion: 1,
          revision: 1,
          source: {
            kind: "pack",
            location: {
              oid,
              pack: "fixture",
              offset: 0,
              length: object.bytes.length,
              type: object.kind,
              size: object.bytes.length,
            },
          },
          bytesWritten: object.bytes.length,
          checkpoint: null,
          complete: true,
        };
  };
  const reads: Array<{ oid: string; offset: number; maxBytes: number; length: number }> = [];
  const reader = {
    searchTreeOf: vi.fn((_commit: string | null) =>
      Effect.succeed({ ready: true as const, tree: root }),
    ),
    sizes: vi.fn((oids: ReadonlyArray<string>) =>
      Effect.succeed(new Map(oids.map((oid) => [oid, sizes.get(oid) ?? null]))),
    ),
    metadata: {
      prepare: vi.fn((oid: string) => {
        const object = objects.get(oid)!;
        return Effect.succeed({
          complete: true,
          state: state(oid)!,
          kind: object.kind,
          size: object.bytes.length,
        });
      }),
      status: vi.fn((oid: string) => Effect.succeed(state(oid))),
      bytes: vi.fn((oid: string, offset: number, maxBytes: number) => {
        const object = objects.get(oid)!;
        const bytes = object.bytes.slice(offset, offset + maxBytes);
        const nextOffset = offset + bytes.length;
        reads.push({ oid, offset, maxBytes, length: bytes.length });
        return Effect.succeed({
          _tag: nextOffset === object.bytes.length ? ("complete" as const) : ("more" as const),
          bytes,
          nextOffset,
        });
      }),
    },
  } satisfies Pick<DriveReader, "searchTreeOf" | "metadata" | "sizes">;
  const readFiles = () =>
    reader.metadata.bytes.mock.calls.flatMap(([oid]) =>
      objects.get(oid)?.kind === "blob" ? [aliases.get(oid)!] : [],
    );
  return { reader, root, sizes, readFiles, reads };
}

function fixture(files: Record<string, FixtureFile>) {
  const trees = new Map<string, TreeEntry[]>([["root", []]]);
  const objects = new Map<string, { bytes: Bytes; kind: "tree" | "blob" }>();
  const sizes = new Map<string, number | null>();
  const ids = new Map<string, string>();
  const aliases = new Map<string, string>();
  const objectId = (alias: string) => {
    let oid = ids.get(alias);
    if (oid === undefined) {
      oid = fixtureId(ids.size + 1);
      ids.set(alias, oid);
      aliases.set(oid, alias);
    }
    return oid;
  };
  const root = objectId("root");
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split("/");
    let tree = "root";
    for (const part of parts.slice(0, -1)) {
      const child = `${tree}/${part}`;
      if (!trees.has(child)) {
        trees.set(child, []);
        trees
          .get(tree)!
          .push({ name: part, kind: "directory", mode: "40000", oid: objectId(child) });
      }
      tree = child;
    }
    const file = typeof value === "string" ? { contents: value } : value;
    const oid = objectId(`blob:${path}`);
    const bytes = typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents;
    objects.set(oid, { bytes, kind: "blob" });
    sizes.set(oid, file.size === undefined ? bytes.length : file.size);
    const kind = file.kind ?? "file";
    const mode = {
      file: "100644",
      executable: "100755",
      symlink: "120000",
      submodule: "160000",
      directory: "40000",
    }[kind];
    trees.get(tree)!.push({ name: parts.at(-1)!, kind, mode, oid });
  }
  for (const [alias, entries] of trees) {
    const chunks = entries.map((entry) => {
      const header = encoder.encode(`${entry.mode} ${entry.name}\0`);
      const bytes = new Uint8Array(header.length + 20);
      bytes.set(header);
      for (let index = 0; index < 20; index++)
        bytes[header.length + index] = Number.parseInt(
          entry.oid.slice(index * 2, index * 2 + 2),
          16,
        );
      return bytes;
    });
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const oid = objectId(alias);
    objects.set(oid, { bytes, kind: "tree" });
    sizes.set(oid, bytes.length);
  }
  return metadataFixture(objects, root, aliases, sizes);
}

const decodeState = Schema.decodeSync(Schema.fromJsonString(DriveContentScanState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(DriveContentScanState));
const roundTrip = (state: DriveContentScanState) => decodeState(encodeState(state));

const drain = (
  test: ReturnType<typeof metadataFixture>,
  budget: DriveContentScanBudget = {},
  maxPages = 5000,
) =>
  Effect.gen(function* () {
    let state: DriveContentScanState | null = null;
    const matches = [];
    let largestState = 0;
    let resumedIgnore = false;
    for (let page = 1; page <= maxPages; page++) {
      const readFrom = test.reads.length;
      const result = yield* scanDriveContents(test.reader, "commit", input, state, budget);
      const reads = test.reads.slice(readFrom);
      expect(reads.every((read) => read.maxBytes <= 64 * 1024)).toBe(true);
      expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(
        budget.bytes ?? 12 * 1024 * 1024,
      );
      matches.push(...result.matches);
      if (result.nextState === undefined)
        return { matches, pages: page, truncated: result.truncated, largestState, resumedIgnore };
      expect(result.truncated).toBe(true);
      largestState = Math.max(largestState, encoder.encode(encodeState(result.nextState)).length);
      resumedIgnore ||=
        result.nextState.candidate?.evaluation !== null &&
        result.nextState.candidate?.evaluation !== undefined;
      state = roundTrip(result.nextState);
    }
    return yield* Effect.die("The search did not finish within its fixture page budget.");
  });

describe("immutable drive content pages", () => {
  it.effect("reads an empty drive without requiring a stored empty-tree object", () =>
    Effect.gen(function* () {
      const { reader } = fixture({});
      reader.searchTreeOf.mockReturnValue(Effect.succeed({ ready: true, tree: EMPTY_TREE }));
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
      expect(reader.searchTreeOf).toHaveBeenCalledTimes(1);
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
      expect(reader.searchTreeOf).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(first.nextState)).toBe(original);
    }),
  );

  it.effect("continues empty bounded pages until a late matching file", () =>
    Effect.gen(function* () {
      const { reader } = fixture({ "a.txt": "no", "b.txt": "no", "nested/late.txt": "needle" });
      let state: DriveContentScanState | null = null;
      const matches = [];
      for (let page = 0; page < 100; page++) {
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
      expect(reader.searchTreeOf).toHaveBeenCalledTimes(1);
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
      for (let page = 0; page < 100; page++) {
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
      expect(reader.searchTreeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("charges both tree passes and resumes without skipping deferred files", () =>
    Effect.gen(function* () {
      const test = fixture({ "a.txt": "needle", "b.txt": "needle" });
      const result = yield* drain(test, { bytes: 60 }, 100);
      expect(result.pages).toBeGreaterThan(2);
      expect(result.matches.map((match) => match.path)).toEqual(["a.txt", "b.txt"]);
      expect(result.truncated).toBe(false);
      expect(test.readFiles()).toEqual(["blob:a.txt", "blob:b.txt"]);
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
      const { reader, sizes, root } = fixture({ ".gitignore": "skip\n", "keep.txt": "needle" });
      const byteLimit = sizes.get(root)!;
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
      expect(reader.searchTreeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("honors nested ignore rules, .ignore precedence, negation, and directory pruning", () =>
    Effect.gen(function* () {
      const { reader, readFiles } = fixture({
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
      expect(readFiles()).not.toContain("blob:blocked/.gitignore");
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
        const { reader, readFiles } = fixture({
          ".gitignore": "folder*/\n*.log\n",
          "nested/.gitignore": "!folder*/\n",
          [`nested/${name}/keep.txt`]: "needle",
          [`nested/${name}/skip.log`]: "needle",
        });
        const result = yield* scanDriveContents(reader, "commit", input);
        expect(result.matches.map((match) => match.path)).toEqual([`nested/${name}/keep.txt`]);
        expect(readFiles()).not.toContain(`blob:nested/${name}/skip.log`);
      }
    }),
  );

  it.effect(
    "excludes binary, oversized, symlink and submodule content without fetching oversized objects",
    () =>
      Effect.gen(function* () {
        const { reader, readFiles } = fixture({
          "binary.txt": `${"x".repeat(9000)}\0needle`,
          "huge.txt": { contents: "needle", size: 10 * 1024 * 1024 + 1 },
          link: { contents: "needle", kind: "symlink" },
          module: { contents: "needle", kind: "submodule" },
          "needle.jpg": "needle",
          "regular.txt": "needle",
        });
        const result = yield* scanDriveContents(reader, "commit", input);
        expect(result.matches.map((match) => match.path)).toEqual(["regular.txt"]);
        expect(readFiles()).toEqual(["blob:binary.txt", "blob:regular.txt"]);
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

  it.effect(
    "keeps truncation honest after the per-file cap while searching hydrated unknown-size files",
    () =>
      Effect.gen(function* () {
        const { reader, readFiles } = fixture({
          "dense.txt": "needle\n".repeat(101),
          "unknown.txt": { contents: "needle", size: null },
          "other.txt": "needle",
        });
        const result = yield* scanDriveContents(reader, "commit", input);
        expect(result.matches.filter((match) => match.path === "dense.txt")).toHaveLength(100);
        expect(result.matches.at(-1)?.path).toBe("other.txt");
        expect(result.truncated).toBe(true);
        expect(result.nextState).toBeUndefined();
        expect(readFiles()).toContain("blob:unknown.txt");
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
      const { reader, readFiles } = fixture({
        "shared/hidden.txt": "needle",
        "same.txt": "needle",
        "keep.txt": "needle",
      });
      const result = yield* scanDriveContents(reader, "commit", input, null, {
        excludePaths: ["shared", "same.txt"],
      });
      expect(result.matches.map((match) => match.path)).toEqual(["keep.txt"]);
      expect(readFiles()).toEqual(["blob:keep.txt"]);
    }),
  );

  it.effect("streams an ignore rule above 64 KiB without dropping the excluded subtree", () =>
    Effect.gen(function* () {
      const test = fixture({
        ".gitignore": { contents: `${"s".repeat(70 * 1024)}\nsecret/\n`, size: null },
        "secret/file.txt": "needle",
        "keep.txt": "needle",
      });
      const result = yield* drain(test, { entries: 3, bytes: 128 * 1024 }, 100);
      expect(result.matches.map((match) => match.path)).toEqual(["keep.txt"]);
      expect(result.resumedIgnore).toBe(true);
      expect(result.largestState).toBeLessThan(16 * 1024);
      expect(result.truncated).toBe(false);
      expect(test.readFiles()).not.toContain("blob:secret/file.txt");
    }),
  );

  it.effect("walks nested ignore sources beyond 512 KiB without accumulating their text", () =>
    Effect.gen(function* () {
      const files: Record<string, FixtureFile> = {};
      const rules = `${"z".repeat(70 * 1024)}\n`;
      let prefix = "";
      for (let depth = 0; depth < 8; depth++) {
        files[`${prefix}.gitignore`] = `${rules}${depth === 0 ? "blocked.txt\n" : ""}`;
        prefix += `nested-${depth}/`;
      }
      files[`${prefix}keep.txt`] = "needle";
      files[`${prefix}blocked.txt`] = "needle";
      expect(encoder.encode(rules).length * 8).toBeGreaterThan(512 * 1024);
      const test = fixture(files);
      const result = yield* drain(test, { entries: 8, bytes: 128 * 1024 }, 1000);
      expect(result.matches.map((match) => match.path)).toEqual([`${prefix}keep.txt`]);
      expect(result.resumedIgnore).toBe(true);
      expect(result.largestState).toBeLessThan(16 * 1024);
      expect(result.truncated).toBe(false);
      expect(test.readFiles()).not.toContain(`blob:${prefix}blocked.txt`);
    }),
  );

  it.effect("searches a real Git tree above 10 MiB through bounded cold pages", () =>
    Effect.gen(function* () {
      const count = 180_000;
      const root = fixtureId(1);
      const blob = fixtureId(2);
      const nameFor = (index: number) =>
        `entry-${String(index).padStart(6, "0")}-long-tree-file.txt`;
      const header = encoder.encode(`160000 ${nameFor(0)}\0`);
      const entryBytes = header.length + 20;
      const tree = new Uint8Array(entryBytes * count);
      for (let index = 0; index < count; index++) {
        const offset = index * entryBytes;
        tree.set(
          encoder.encode(`${index === count - 1 ? "100644" : "160000"} ${nameFor(index)}\0`),
          offset,
        );
        tree[offset + entryBytes - 1] = 2;
      }
      expect(tree.length).toBeGreaterThan(10 * 1024 * 1024);
      const test = metadataFixture(
        new Map([
          [root, { bytes: tree, kind: "tree" as const }],
          [blob, { bytes: encoder.encode("needle"), kind: "blob" as const }],
        ]),
        root,
        new Map([[blob, "blob:late.txt"]]),
      );
      const result = yield* drain(test, { entries: 2000, bytes: 256 * 1024 }, 2000);
      expect(result.matches.map((match) => match.path)).toEqual([nameFor(count - 1)]);
      expect(result.pages).toBeGreaterThan(100);
      expect(result.largestState).toBeLessThan(2048);
      expect(result.truncated).toBe(false);
      expect(test.reader.searchTreeOf).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses hydrated tree metadata even when its recorded object size is unknown", () =>
    Effect.gen(function* () {
      const test = fixture({ "file.txt": "needle" });
      test.sizes.set(test.root, null);
      const result = yield* drain(test, { entries: 2, bytes: 64 });
      expect(result.matches.map((match) => match.path)).toEqual(["file.txt"]);
      expect(result.truncated).toBe(false);
    }),
  );
});
