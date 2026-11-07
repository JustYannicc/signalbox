import { SHA1 } from "@noble/hashes/legacy";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

const integer = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const word = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0xffff_ffff),
);

export const MetadataHashState = Schema.Struct({
  format: Schema.Literal("git-sha1-v1"),
  length: integer,
  words: Schema.Tuple([word, word, word, word, word]),
  pending: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(63)),
}).check(Schema.makeFilter((state) => state.pending.length === state.length % 64));
export type MetadataHashState = typeof MetadataHashState.Type;

// Git's id covers the complete object, including remote ranges fetched over several cold starts.
class ResumableSha1 extends SHA1 {
  constructor(state?: MetadataHashState) {
    super();
    if (state !== undefined) {
      this.set(...state.words);
      this.length = state.length;
      this.pos = state.pending.length;
      this.buffer.set(state.pending);
    }
  }

  snapshot(): MetadataHashState {
    const [a, b, c, d, e] = this.get();
    return {
      format: "git-sha1-v1",
      length: this.length,
      words: [a >>> 0, b >>> 0, c >>> 0, d >>> 0, e >>> 0],
      pending: this.buffer.slice(0, this.pos),
    };
  }
}

export const beginMetadataHash = (kind: "blob" | "tree" | "commit" | "tag", size: number) => {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid Git object size.");
  return new ResumableSha1().update(new TextEncoder().encode(`${kind} ${size}\0`)).snapshot();
};

export const hashMetadataChunk = (state: MetadataHashState, bytes: Uint8Array) => {
  if (bytes.length > 64 * 1024) throw new RangeError("A metadata hash step exceeds 64 KiB.");
  if (!Number.isSafeInteger(state.length + bytes.length))
    throw new RangeError("The Git object length exceeds the supported integer range.");
  return new ResumableSha1(state).update(bytes).snapshot();
};

export const metadataHashId = (state: MetadataHashState) =>
  Hex.encode(new ResumableSha1(state).digest());
