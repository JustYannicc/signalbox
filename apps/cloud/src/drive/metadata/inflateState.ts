import * as Schema from "effect/Schema";

export const INFLATE_MAX_BYTES = 64 * 1024;
export const INFLATE_MAX_CHECKPOINT_BYTES = 64 * 1024;
export const INFLATE_FORMAT = "pako-2.1.0-zlib-le-v1";

const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const count = integer(0, Number.MAX_SAFE_INTEGER);
const word = integer(-0x80000000, 0xffffffff);

// Pako 2.1.0's zlib-only state, not a general object serializer. Changing the
// dependency or these fields requires a new checkpoint format.
export const InflateScalars = Schema.Struct({
  mode: integer(16180, 16206).check(
    Schema.makeFilter((mode) => mode === 16180 || mode === 16189 || mode >= 16191),
  ),
  last: integer(0, 1),
  wrap: Schema.Literal(5),
  havedict: Schema.Literal(0),
  flags: integer(-1, 0),
  dmax: integer(256, 32768),
  check: word,
  total: count,
  wbits: Schema.Literal(15),
  wsize: Schema.Literals([0, 32768]),
  whave: integer(0, 32768),
  wnext: integer(0, 32767),
  hold: word,
  bits: integer(0, 32),
  length: integer(0, 65535),
  offset: integer(0, 32768),
  extra: integer(0, 15),
  lenbits: integer(0, 15),
  distbits: integer(0, 15),
  ncode: integer(0, 19),
  nlen: integer(0, 286),
  ndist: integer(0, 30),
  have: integer(0, 320),
  sane: Schema.Literal(1),
  back: integer(-1, 64),
  was: integer(0, 258),
});
export type InflateScalars = typeof InflateScalars.Type;

export const arrayFields = [
  "window",
  "lencode",
  "distcode",
  "lens",
  "work",
  "lendyn",
  "distdyn",
] as const;
export type ArrayField = (typeof arrayFields)[number];
const reference = integer(0, 6);
const ArrayData = Schema.NullOr(
  Schema.Struct({
    type: Schema.Literals(["u8", "u16", "i32"]),
    data: Schema.String.check(Schema.isMaxLength(43692)),
  }),
);

export const InflateCheckpoint = Schema.Struct({
  format: Schema.Literal(INFLATE_FORMAT),
  expectedSize: count,
  sourceOffset: count,
  expandedOffset: count,
  stream: Schema.Struct({
    data_type: integer(0, 511),
    adler: word,
  }),
  state: InflateScalars,
  refs: Schema.Struct({
    window: Schema.NullOr(reference),
    lencode: reference,
    distcode: reference,
    lens: reference,
    work: reference,
    lendyn: reference,
    distdyn: reference,
  }),
  // A fixed tuple bounds decoding work even for malformed persisted arrays.
  arrays: Schema.Tuple([
    ArrayData,
    ArrayData,
    ArrayData,
    ArrayData,
    ArrayData,
    ArrayData,
    ArrayData,
  ]),
}).check(
  Schema.makeFilter(
    (value) =>
      value.expandedOffset <= value.expectedSize &&
      value.state.total === value.expandedOffset &&
      value.arrays.reduce((size, array) => size + (array?.data.length ?? 0), 0) <= 60000,
  ),
);
export type InflateCheckpoint = typeof InflateCheckpoint.Type;
