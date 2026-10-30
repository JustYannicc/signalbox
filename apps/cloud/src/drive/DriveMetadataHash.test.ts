import { describe, expect, it } from "@effect/vitest";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

import {
  beginMetadataHash,
  hashMetadataChunk,
  metadataHashId,
  MetadataHashState,
} from "./DriveMetadataHash.ts";

const codec = Schema.fromJsonString(MetadataHashState);
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const encoder = new TextEncoder();

describe("persistent Git metadata hashes", () => {
  it("matches WebCrypto through cold checkpoints at block and chunk boundaries", async () => {
    for (const kind of ["blob", "tree", "commit", "tag"] as const) {
      for (const size of [0, 1, 63, 64, 65, 511, 64 * 1024 + 37]) {
        const content = Uint8Array.from({ length: size }, (_, index) => (index * 137) % 256);
        const header = encoder.encode(`${kind} ${size}\0`);
        const whole = new Uint8Array(header.length + content.length);
        whole.set(header);
        whole.set(content, header.length);
        const expected = Hex.encode(new Uint8Array(await crypto.subtle.digest("SHA-1", whole)));
        let state = beginMetadataHash(kind, size);
        let offset = 0;
        for (const length of [1, 17, 63, 64, 511, 64 * 1024, 64 * 1024]) {
          state = decode(encode(state));
          const chunk = content.subarray(offset, offset + length);
          state = hashMetadataChunk(state, chunk);
          offset += chunk.length;
        }
        expect(offset).toBe(size);
        expect(metadataHashId(decode(encode(state)))).toBe(expected);
        expect(encode(state).length).toBeLessThan(300);
      }
    }
  });

  it("keeps a checkpoint replayable after hashing or finalizing its successor", () => {
    const first = hashMetadataChunk(beginMetadataHash("blob", 6), encoder.encode("abc"));
    const saved = encode(first);
    const completed = hashMetadataChunk(first, encoder.encode("def"));
    const id = metadataHashId(completed);
    expect(metadataHashId(completed)).toBe(id);
    expect(metadataHashId(hashMetadataChunk(decode(saved), encoder.encode("def")))).toBe(id);
    expect(encode(first)).toBe(saved);
  });

  it("refuses oversized work without changing the saved hash", () => {
    const state = beginMetadataHash("blob", 64 * 1024 + 1);
    const saved = encode(state);
    expect(() => hashMetadataChunk(state, new Uint8Array(64 * 1024 + 1))).toThrow(RangeError);
    expect(encode(state)).toBe(saved);
    expect(() => beginMetadataHash("blob", -1)).toThrow(RangeError);
  });

  it("rejects a persisted checkpoint with inconsistent partial-block bytes", () => {
    const state = beginMetadataHash("blob", 0);
    const invalid = { ...state, length: state.length + 1, pending: "" };
    expect(() => decode(JSON.stringify(invalid))).toThrow();
  });
});
