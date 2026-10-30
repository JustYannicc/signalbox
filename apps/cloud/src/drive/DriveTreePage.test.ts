import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { beginTreePage, stepTreePage, TreePagePosition } from "./DriveTreePage.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = Schema.fromJsonString(TreePagePosition);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const oidBytes = Uint8Array.from({ length: 20 }, (_, index) => index * 11);
const oid = [...oidBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const combine = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};
const entry = (mode: string, name: string | Uint8Array) =>
  combine(
    encoder.encode(`${mode} `),
    typeof name === "string" ? encoder.encode(name) : name,
    new Uint8Array([0]),
    oidBytes,
  );

const collect = (bytes: Uint8Array, chunkBytes: number, maxEntries = 512) =>
  Effect.gen(function* () {
    let position = beginTreePage();
    const entries: Array<Effect.Success<ReturnType<typeof stepTreePage>>["entries"][number]> = [];
    const offsets: number[] = [];
    for (let call = 0; call < bytes.length + 1; call++) {
      const input = bytes.subarray(position.byteOffset, position.byteOffset + chunkBytes);
      const saved = encode(position);
      const page = yield* stepTreePage({
        position,
        bytes: input,
        sourceEnded: position.byteOffset + input.length === bytes.length,
        maxEntries,
      });
      expect(encode(position)).toBe(saved);
      expect(page.consumed).toBeLessThanOrEqual(64 * 1024);
      expect(page.entries.length).toBeLessThanOrEqual(maxEntries);
      expect(page.entryOffsets).toHaveLength(page.entries.length);
      expect(page.position.byteOffset).toBe(position.byteOffset + page.consumed);
      entries.push(...page.entries);
      offsets.push(...page.entryOffsets);
      position = decode(encode(page.position));
      if (page.done) return { entries, offsets, position };
      expect(page.consumed).toBeGreaterThan(0);
    }
    return yield* Effect.die("Tree parser did not finish.");
  });

describe("incremental Git tree pages", () => {
  it.effect("preserves Git modes, entry order, and every partial-entry boundary", () =>
    Effect.gen(function* () {
      const modes = ["100644", "100755", "120000", "40000", "160000", "123456", ""];
      const kinds = ["file", "executable", "symlink", "directory", "submodule", "file", "file"];
      const parts = modes.map((mode, index) => entry(mode, `entry-${index}-🚲.txt`));
      const bytes = combine(...parts);
      let offset = 0;
      const expectedOffsets = parts.map((part) => (offset += part.length));
      for (const chunkBytes of [1, 2, 3, 7, bytes.length]) {
        const result = yield* collect(bytes, chunkBytes, 2);
        expect(result.entries).toEqual(
          modes.map((mode, index) => ({
            mode,
            kind: kinds[index],
            name: `entry-${index}-🚲.txt`,
            oid,
          })),
        );
        expect(result.offsets).toEqual(expectedOffsets);
        expect(result.position).toEqual({ ...beginTreePage(), byteOffset: bytes.length });
      }
    }),
  );

  it.effect("decodes split UTF-8, BOMs, and invalid byte replacement like whole TextDecoder", () =>
    Effect.gen(function* () {
      const names = [
        new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xef, 0xbb, 0xbf]),
        new Uint8Array([0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x9a, 0xb2]),
        new Uint8Array([0xe2, 0x82, 0x61, 0xc2, 0xff, 0x80]),
        new Uint8Array([0xe0, 0x80, 0xed, 0xa0, 0xf0, 0x80, 0xf4, 0x90]),
        new Uint8Array([0xf0, 0x9f, 0x9a]),
        new Uint8Array(),
      ];
      const bytes = combine(...names.map((name) => entry("100644", name)));
      for (const chunkBytes of [1, 2, 3, 4, 5, 11]) {
        const result = yield* collect(bytes, chunkBytes);
        expect(result.entries.map((item) => item.name)).toEqual(
          names.map((name) => decoder.decode(name)),
        );
      }
    }),
  );

  it.effect("returns exact byte offsets for restarting at any emitted entry boundary", () =>
    Effect.gen(function* () {
      const bytes = combine(entry("100644", "first"), entry("40000", "folder"), entry("", ""));
      const first = yield* stepTreePage({
        position: beginTreePage(),
        bytes,
        sourceEnded: true,
        maxEntries: 2,
      });
      expect(first.done).toBe(false);
      expect(first.entries.map((item) => item.name)).toEqual(["first", "folder"]);
      for (const [index, byteOffset] of first.entryOffsets.entries()) {
        const next = yield* stepTreePage({
          position: { ...beginTreePage(), byteOffset },
          bytes: bytes.subarray(byteOffset),
          sourceEnded: true,
        });
        expect(next.done).toBe(true);
        expect(next.entries.map((item) => item.name)).toEqual(index === 0 ? ["folder", ""] : [""]);
      }
    }),
  );

  it.effect("resumes a single name spanning many pages without an arbitrary name cap", () =>
    Effect.gen(function* () {
      const name = `${"long-name-🚲".repeat(20_000)}.txt`;
      const result = yield* collect(entry("100644", name), 64 * 1024);
      expect(result.entries).toEqual([{ mode: "100644", kind: "file", name, oid }]);
    }),
  );

  it.effect("walks 180,000 entries beyond 10 MiB with 500-entry pages and cold checkpoints", () =>
    Effect.gen(function* () {
      const count = 180_000;
      const nameFor = (index: number) =>
        `entry-${index.toString().padStart(6, "0")}-long-tree-file.txt`;
      const sample = entry("100644", nameFor(0));
      const bytes = new Uint8Array(sample.length * count);
      for (let index = 0; index < count; index++)
        bytes.set(entry("100644", nameFor(index)), index * sample.length);
      expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024);
      let position = beginTreePage();
      let emitted = 0;
      let calls = 0;
      while (true) {
        const input = bytes.subarray(position.byteOffset, position.byteOffset + 64 * 1024);
        const page = yield* stepTreePage({
          position,
          bytes: input,
          sourceEnded: position.byteOffset + input.length === bytes.length,
          maxEntries: 500,
        });
        expect(page.entries.length).toBeLessThanOrEqual(500);
        expect(page.consumed).toBeLessThanOrEqual(64 * 1024);
        expect(encode(page.position).length).toBeLessThan(400);
        let correct = true;
        for (const [index, item] of page.entries.entries()) {
          if (item.name !== nameFor(emitted + index) || item.oid !== oid) correct = false;
          if (page.entryOffsets[index] !== (emitted + index + 1) * sample.length) correct = false;
        }
        expect(correct).toBe(true);
        emitted += page.entries.length;
        calls++;
        position = decode(encode(page.position));
        if (page.done) break;
        expect(page.consumed).toBeGreaterThan(0);
      }
      expect(emitted).toBe(count);
      expect(calls).toBe(Math.ceil(count / 500));
      expect(position.byteOffset).toBe(bytes.length);
    }),
  );

  it.effect("accepts an empty tree and reports final truncation in each parser phase", () =>
    Effect.gen(function* () {
      expect(
        yield* stepTreePage({
          position: beginTreePage(),
          bytes: new Uint8Array(),
          sourceEnded: true,
        }),
      ).toMatchObject({ done: true, consumed: 0, entries: [], entryOffsets: [] });
      for (const [bytes, phase] of [
        [encoder.encode("100644"), "mode"],
        [encoder.encode("100644 missing-nul"), "name"],
        [entry("100644", "short-oid").slice(0, -1), "oid"],
      ] as const) {
        expect(
          yield* stepTreePage({ position: beginTreePage(), bytes, sourceEnded: true }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: "DriveTreePageError",
          reason: "truncated-entry",
          byteOffset: bytes.length,
          phase,
        });
      }
    }),
  );

  it.effect("rejects invalid checkpoints and budgets before consuming input", () =>
    Effect.gen(function* () {
      for (const maxEntries of [0, 1.5, 513]) {
        expect(
          yield* stepTreePage({
            position: beginTreePage(),
            bytes: new Uint8Array(),
            sourceEnded: true,
            maxEntries,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DriveTreePageError", reason: "invalid-input", byteOffset: 0 });
      }
      expect(
        yield* stepTreePage({
          position: beginTreePage(),
          bytes: new Uint8Array(65537),
          sourceEnded: false,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-input" });
      expect(
        yield* stepTreePage({
          position: { ...beginTreePage(), textTail: [255] },
          bytes: new Uint8Array(),
          sourceEnded: false,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-position", cause: { _tag: "SchemaError" } });
      expect(
        yield* stepTreePage({
          position: { ...beginTreePage(), byteOffset: Number.MAX_SAFE_INTEGER },
          bytes: new Uint8Array([32]),
          sourceEnded: false,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "offset-overflow" });
    }),
  );
});
