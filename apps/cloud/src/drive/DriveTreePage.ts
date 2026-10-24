import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TreeEntry } from "./git/gitObjects.ts";

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 512;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const hex = "0123456789abcdef";
const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Phase = Schema.Literals(["mode", "name", "oid"]);
const Byte = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(255));

/** The suffix a streaming TextDecoder would retain, including UTF-8's restricted second bytes. */
function incompleteTailAt(bytes: Uint8Array): number {
  const length = bytes.length;
  if (length === 0) return 0;
  let start = length - 1;
  for (let count = 0; count < 3 && start > 0; count++) {
    const byte = bytes[start]!;
    if (byte < 0x80 || byte > 0xbf) break;
    start--;
  }
  const lead = bytes[start]!;
  const expected =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  if (expected === 0 || length - start >= expected) return length;
  if (length - start > 1) {
    const second = bytes[start + 1]!;
    if (
      (lead === 0xe0 && second < 0xa0) ||
      (lead === 0xed && second > 0x9f) ||
      (lead === 0xf0 && second < 0x90) ||
      (lead === 0xf4 && second > 0x8f)
    )
      return length;
  }
  return start;
}

export const TreePagePosition = Schema.Struct({
  format: Schema.Literal("git-tree-page-v1"),
  byteOffset: Count,
  phase: Phase,
  mode: Schema.String,
  name: Schema.String,
  textStarted: Schema.Boolean,
  textTail: Schema.Array(Byte).check(Schema.isMaxLength(3)),
  oid: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2}){0,19}$/)),
}).check(
  Schema.makeFilter((position) => {
    if (position.textTail.length > 0 && incompleteTailAt(new Uint8Array(position.textTail)) !== 0)
      return false;
    if (position.phase === "oid") return position.textTail.length === 0 && !position.textStarted;
    if (position.oid !== "") return false;
    if (position.phase === "mode" && position.name !== "") return false;
    return (
      position.textStarted || (position.phase === "mode" ? position.mode : position.name) === ""
    );
  }),
);
export type TreePagePosition = typeof TreePagePosition.Type;

export class DriveTreePageError extends Schema.TaggedError<DriveTreePageError>()(
  "DriveTreePageError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "invalid-position",
      "truncated-entry",
      "offset-overflow",
    ]),
    byteOffset: Count,
    phase: Phase,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason === "truncated-entry"
      ? "The Git tree ends inside an entry."
      : "Invalid incremental Git tree operation.";
  }
}

export const beginTreePage = (): TreePagePosition => ({
  format: "git-tree-page-v1",
  byteOffset: 0,
  phase: "mode",
  mode: "",
  name: "",
  textStarted: false,
  textTail: [],
  oid: "",
});

const decodePosition = Schema.decodeUnknownEffect(TreePagePosition);
const kindOf = (mode: string): TreeEntry["kind"] => {
  switch (mode) {
    case "40000":
      return "directory";
    case "100755":
      return "executable";
    case "120000":
      return "symlink";
    case "160000":
      return "submodule";
    default:
      return "file";
  }
};

/** Input starts at byteOffset; only a partial entry survives a call. */
export const stepTreePage = (input: {
  readonly position: TreePagePosition;
  readonly bytes: Uint8Array;
  readonly sourceEnded: boolean;
  readonly maxEntries?: number;
}) =>
  Effect.gen(function* () {
    const saved = yield* decodePosition(input.position).pipe(
      Effect.mapError(
        (cause) =>
          new DriveTreePageError({
            reason: "invalid-position",
            byteOffset: 0,
            phase: "mode",
            cause,
          }),
      ),
    );
    const maxEntries = input.maxEntries ?? MAX_ENTRIES;
    const fail = (reason: DriveTreePageError["reason"], consumed = 0) =>
      new DriveTreePageError({
        reason,
        byteOffset: saved.byteOffset + consumed,
        phase: position.phase,
      });
    const position = { ...saved, textTail: [...saved.textTail] };
    if (
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.length > MAX_BYTES ||
      typeof input.sourceEnded !== "boolean" ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > MAX_ENTRIES
    )
      return yield* fail("invalid-input");
    if (saved.byteOffset > Number.MAX_SAFE_INTEGER - input.bytes.length)
      return yield* fail("offset-overflow");

    const appendText = (bytes: Uint8Array, end: boolean) => {
      let joined = bytes;
      if (position.textTail.length > 0) {
        joined = new Uint8Array(position.textTail.length + bytes.length);
        joined.set(position.textTail);
        joined.set(bytes, position.textTail.length);
      }
      const cut = end ? joined.length : incompleteTailAt(joined);
      let text = decoder.decode(joined.subarray(0, cut));
      if (!position.textStarted && text.length > 0) {
        if (text[0] === "\uFEFF") text = text.slice(1);
        position.textStarted = true;
      }
      if (position.phase === "mode") position.mode += text;
      else position.name += text;
      position.textTail = [...joined.subarray(cut)];
    };
    const entries: TreeEntry[] = [];
    const entryOffsets: number[] = [];
    let consumed = 0;
    while (consumed < input.bytes.length && entries.length < maxEntries) {
      if (position.phase === "oid") {
        const take = Math.min(20 - position.oid.length / 2, input.bytes.length - consumed);
        for (const byte of input.bytes.subarray(consumed, consumed + take))
          position.oid += hex[byte >> 4]! + hex[byte & 15]!;
        consumed += take;
        if (position.oid.length === 40) {
          entries.push({
            mode: position.mode,
            kind: kindOf(position.mode),
            name: position.name,
            oid: position.oid,
          });
          entryOffsets.push(saved.byteOffset + consumed);
          Object.assign(position, beginTreePage());
        }
        continue;
      }
      const end = input.bytes.indexOf(position.phase === "mode" ? 0x20 : 0, consumed);
      const next = end === -1 ? input.bytes.length : end;
      appendText(input.bytes.subarray(consumed, next), end !== -1);
      consumed = next;
      if (end !== -1) {
        consumed++;
        position.phase = position.phase === "mode" ? "name" : "oid";
        position.textStarted = false;
      }
    }
    position.byteOffset = saved.byteOffset + consumed;
    const boundary =
      position.phase === "mode" &&
      position.mode === "" &&
      !position.textStarted &&
      position.textTail.length === 0;
    const ended = input.sourceEnded && consumed === input.bytes.length;
    if (ended && !boundary) return yield* fail("truncated-entry", consumed);
    return { position, entries, entryOffsets, done: ended && boundary, consumed };
  });
