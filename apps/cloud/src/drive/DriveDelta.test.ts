import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { beginDelta, DeltaState, stepDelta } from "./DriveDelta.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = Schema.fromJsonString(DeltaState);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const varint = (initial: number) => {
  const bytes: number[] = [];
  let value = initial;
  do {
    bytes.push((value & 0x7f) | (value >= 128 ? 0x80 : 0));
    value = Math.floor(value / 128);
  } while (value > 0);
  return bytes;
};
const copy = (offset: number, length: number) => [
  0xff,
  offset & 255,
  (offset >>> 8) & 255,
  (offset >>> 16) & 255,
  (offset >>> 24) & 255,
  length & 255,
  (length >>> 8) & 255,
  (length >>> 16) & 255,
];
const combine = (parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};
const reconstruct = (
  base: Uint8Array,
  delta: Uint8Array,
  resultSize: number,
  inputLimit = 1,
  outputLimit = 17,
  baseReadLimit = 3,
) =>
  Effect.gen(function* () {
    let state = beginDelta(base.length, resultSize);
    let offset = 0;
    let requested: { offset: number; length: number } | undefined;
    const output: Uint8Array[] = [];
    const reads: Array<{ offset: number; length: number }> = [];
    for (let step = 0; step < 20_000; step++) {
      const bytes = delta.subarray(offset, offset + inputLimit);
      const saved = encode(state);
      if (requested !== undefined) reads.push(requested);
      const page = yield* stepDelta({
        state,
        input: bytes,
        sourceEnded: offset + bytes.length === delta.length,
        outputLimit,
        ...(requested === undefined
          ? {}
          : {
              base: {
                offset: requested.offset,
                bytes: base.subarray(
                  requested.offset,
                  requested.offset + Math.min(requested.length, baseReadLimit),
                ),
              },
            }),
      });
      expect(encode(state)).toBe(saved);
      expect(page.output.length).toBeLessThanOrEqual(outputLimit);
      expect(page.consumed).toBeLessThanOrEqual(64 * 1024);
      expect(encode(page.state).length).toBeLessThan(500);
      offset += page.consumed;
      output.push(page.output);
      state = decode(encode(page.state));
      requested = page.needBase;
      if (page.done) return { bytes: combine(output), reads, consumed: offset };
    }
    return yield* Effect.die("Delta did not finish.");
  });

describe("persistent delta reconstruction", () => {
  it.effect("reorders arbitrary base ranges and inserts bytes through cold checkpoints", () =>
    Effect.gen(function* () {
      const base = encoder.encode("Hello world");
      const delta = Uint8Array.from([
        ...varint(base.length),
        ...varint(11),
        ...copy(6, 5),
        1,
        32,
        ...copy(0, 5),
      ]);
      const result = yield* reconstruct(base, delta, 11);
      expect(decoder.decode(result.bytes)).toBe("world Hello");
      expect(result.consumed).toBe(delta.length);
      expect(result.reads[0]?.offset).toBe(6);
      expect(result.reads.some((read) => read.offset === 0)).toBe(true);
    }),
  );

  it.effect("resumes the default 65536-byte copy without retaining the base", () =>
    Effect.gen(function* () {
      const base = Uint8Array.from({ length: 65_536 }, (_, index) => index % 251);
      const delta = Uint8Array.from([...varint(base.length), ...varint(base.length), 0x80]);
      const result = yield* reconstruct(base, delta, base.length, 2, 4096, 1024);
      expect(result.bytes).toEqual(base);
      expect(result.reads.every((read) => read.length <= 4096)).toBe(true);
    }),
  );

  it.effect("bounds a large copy and consumes an instruction stream larger than one page", () =>
    Effect.gen(function* () {
      const base = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251);
      const delta = Uint8Array.from([
        ...varint(base.length),
        ...varint(base.length),
        ...copy(0, 100_000),
      ]);
      const copied = yield* reconstruct(base, delta, base.length, 64 * 1024, 64 * 1024, 64 * 1024);
      expect(copied.bytes).toEqual(base);
      expect(copied.reads.map((read) => read.length)).toEqual([65_536, 34_464]);

      const literals = Array.from({ length: 520 }, () => [
        127,
        ...new Uint8Array(127).fill(42),
      ]).flat();
      const inserts = Uint8Array.from([...varint(0), ...varint(520 * 127), ...literals]);
      const inserted = yield* reconstruct(
        new Uint8Array(),
        inserts,
        520 * 127,
        inserts.length,
        64 * 1024,
      );
      expect(inserted.bytes).toEqual(new Uint8Array(520 * 127).fill(42));
      expect(inserted.consumed).toBe(inserts.length);
    }),
  );

  it.effect("rejects malformed headers, opcodes, copy ranges and truncated inserts", () =>
    Effect.gen(function* () {
      const cases = [
        { bytes: [4, 3], reason: "header-size" },
        { bytes: [3, 3, 0], reason: "opcode" },
        { bytes: [3, 3, ...copy(2, 2)], reason: "copy-range" },
        { bytes: [3, 3, 3, 1, 2], reason: "truncated" },
        { bytes: [3, 3, 4, 1, 2, 3, 4], reason: "result-size" },
        { bytes: [0x80], reason: "truncated" },
      ];
      for (const item of cases) {
        const failure = yield* reconstruct(new Uint8Array(3), Uint8Array.from(item.bytes), 3).pipe(
          Effect.flip,
        );
        expect(failure).toMatchObject({ _tag: "DriveDeltaError", reason: item.reason });
      }
    }),
  );

  it.effect("rejects an unexpected base range without advancing the pending copy", () =>
    Effect.gen(function* () {
      const first = yield* stepDelta({
        state: beginDelta(3, 2),
        input: Uint8Array.from([3, 2, ...copy(1, 2)]),
        sourceEnded: true,
      });
      expect(first.needBase).toEqual({ offset: 1, length: 2 });
      const saved = encode(first.state);
      const failure = yield* stepDelta({
        state: first.state,
        input: new Uint8Array(),
        sourceEnded: true,
        base: { offset: 0, bytes: Uint8Array.from([1, 2]) },
      }).pipe(Effect.flip);
      expect(failure.reason).toBe("base-range");
      expect(encode(first.state)).toBe(saved);
    }),
  );
});
