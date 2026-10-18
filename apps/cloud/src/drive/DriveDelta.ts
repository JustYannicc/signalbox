import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const phase = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["base-size", "result-size"]),
    value: count,
    shift: count.check(
      Schema.isLessThanOrEqualTo(56),
      Schema.makeFilter((n) => n % 7 === 0),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("opcode") }),
  Schema.Struct({
    kind: Schema.Literal("copy-header"),
    opcode: count.check(Schema.isGreaterThanOrEqualTo(128), Schema.isLessThanOrEqualTo(255)),
    index: count.check(Schema.isLessThanOrEqualTo(7)),
    offset: count.check(Schema.isLessThanOrEqualTo(0xffff_ffff)),
    length: count.check(Schema.isLessThanOrEqualTo(0xff_ffff)),
  }),
  Schema.Struct({ kind: Schema.Literal("copy"), offset: count, remaining: count }),
  Schema.Struct({ kind: Schema.Literal("insert"), remaining: count }),
]);

export const DeltaState = Schema.Struct({
  format: Schema.Literal("git-delta-v1"),
  baseSize: count,
  resultSize: count,
  written: count,
  phase,
}).check(
  Schema.makeFilter(
    (state) =>
      state.written <= state.resultSize &&
      (state.phase.kind !== "copy" ||
        (state.phase.remaining > 0 &&
          state.written + state.phase.remaining <= state.resultSize &&
          state.phase.offset + state.phase.remaining <= state.baseSize)) &&
      (state.phase.kind !== "insert" ||
        (state.phase.remaining > 0 && state.written + state.phase.remaining <= state.resultSize)),
  ),
);
export type DeltaState = typeof DeltaState.Type;

export class DriveDeltaError extends Schema.TaggedError<DriveDeltaError>()("DriveDeltaError", {
  reason: Schema.Literals([
    "limit",
    "header-size",
    "opcode",
    "copy-range",
    "result-size",
    "base-range",
    "truncated",
  ]),
  written: count,
}) {
  override get message() {
    return "The drive's delta could not be reconstructed.";
  }
}

export const beginDelta = (baseSize: number, resultSize: number): DeltaState => {
  if (![baseSize, resultSize].every((size) => Number.isSafeInteger(size) && size >= 0))
    throw new RangeError("Invalid delta size.");
  return {
    format: "git-delta-v1",
    baseSize,
    resultSize,
    written: 0,
    phase: { kind: "base-size", value: 0, shift: 0 },
  };
};

export interface DeltaStep {
  readonly state: DeltaState;
  readonly consumed: number;
  readonly output: Uint8Array<ArrayBuffer>;
  readonly done: boolean;
  readonly needBase?: { readonly offset: number; readonly length: number };
}

/** One bounded output operation; a copy asks for an arbitrary range of the persisted base. */
export const stepDelta = Effect.fn("DriveDelta.step")(function* (input: {
  readonly state: DeltaState;
  readonly input: Uint8Array;
  readonly sourceEnded: boolean;
  readonly base?: { readonly offset: number; readonly bytes: Uint8Array };
  readonly outputLimit?: number;
}): Effect.fn.Return<DeltaStep, DriveDeltaError> {
  const limit = input.outputLimit ?? 64 * 1024;
  const fail = (reason: DriveDeltaError["reason"]) =>
    new DriveDeltaError({ reason, written: input.state.written });
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 * 1024) return yield* fail("limit");
  const bytes = input.input.subarray(0, 64 * 1024);
  const state = { ...input.state, phase: { ...input.state.phase } };
  let consumed = 0;
  let output = new Uint8Array(0);
  let needBase: DeltaStep["needBase"];

  for (;;) {
    const current = state.phase;
    switch (current.kind) {
      case "base-size":
      case "result-size": {
        if (consumed === bytes.length) break;
        const byte = bytes[consumed++]!;
        const value = current.value + (byte & 0x7f) * 2 ** current.shift;
        if (!Number.isSafeInteger(value) || current.shift > 49) return yield* fail("header-size");
        if (byte & 0x80) {
          state.phase = { ...current, value, shift: current.shift + 7 };
          continue;
        }
        if (value !== (current.kind === "base-size" ? state.baseSize : state.resultSize))
          return yield* fail("header-size");
        state.phase =
          current.kind === "base-size"
            ? { kind: "result-size", value: 0, shift: 0 }
            : { kind: "opcode" };
        continue;
      }
      case "opcode": {
        if (consumed === bytes.length) break;
        const opcode = bytes[consumed++]!;
        if (opcode === 0) return yield* fail("opcode");
        if (opcode & 0x80) {
          state.phase = { kind: "copy-header", opcode, index: 0, offset: 0, length: 0 };
        } else {
          if (state.written + opcode > state.resultSize) return yield* fail("result-size");
          state.phase = { kind: "insert", remaining: opcode };
        }
        continue;
      }
      case "copy-header": {
        let { index, offset, length } = current;
        while (index < 7) {
          if (current.opcode & (1 << index)) {
            if (consumed === bytes.length) break;
            const byte = bytes[consumed++]!;
            if (index < 4) offset += byte * 2 ** (index * 8);
            else length += byte * 2 ** ((index - 4) * 8);
          }
          index++;
        }
        if (index < 7) {
          state.phase = { ...current, index, offset, length };
          break;
        }
        if (length === 0) length = 0x1_0000;
        if (offset + length > state.baseSize) return yield* fail("copy-range");
        if (state.written + length > state.resultSize) return yield* fail("result-size");
        state.phase = { kind: "copy", offset, remaining: length };
        continue;
      }
      case "copy": {
        const length = Math.min(current.remaining, limit);
        if (input.base === undefined) {
          needBase = { offset: current.offset, length };
          break;
        }
        if (input.base.offset !== current.offset || input.base.bytes.length === 0)
          return yield* fail("base-range");
        output = input.base.bytes.slice(0, Math.min(length, input.base.bytes.length));
        state.written += output.length;
        state.phase =
          output.length === current.remaining
            ? { kind: "opcode" }
            : {
                kind: "copy",
                offset: current.offset + output.length,
                remaining: current.remaining - output.length,
              };
        break;
      }
      case "insert": {
        if (consumed === bytes.length) break;
        const length = Math.min(current.remaining, limit, bytes.length - consumed);
        output = bytes.slice(consumed, consumed + length);
        consumed += length;
        state.written += length;
        state.phase =
          length === current.remaining
            ? { kind: "opcode" }
            : { kind: "insert", remaining: current.remaining - length };
        break;
      }
    }
    break;
  }
  const exhausted = input.sourceEnded && consumed === input.input.length;
  const done = exhausted && state.phase.kind === "opcode" && state.written === state.resultSize;
  if (
    exhausted &&
    !done &&
    state.phase.kind !== "copy" &&
    output.length === 0 &&
    needBase === undefined
  )
    return yield* fail("truncated");
  return { state, consumed, output, done, ...(needBase === undefined ? {} : { needBase }) };
});
