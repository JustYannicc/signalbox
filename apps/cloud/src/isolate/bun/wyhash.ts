// Wyhash is adapted from Bun 25ef6936's src/wyhash/lib.rs; MIT, see LICENSE.bun.
// Bun cites Wang Yi's public-domain wyhash 77e50f2 as the reference for final4.

import * as u64 from "./hash64.ts";

const SECRET0_LO = 0x78bd642f;
const SECRET0_HI = 0xa0761d64;
const SECRET1_LO = 0xa0b428db;
const SECRET1_HI = 0xe7037ed1;
const A = 0;
const B = 2;
const STATE = 4;
const UPPER = 6;
const STATE1 = 8;
const STATE2 = 10;
// Inputs are normalized before entry; hashing is synchronous and calls no user code,
// so a nested hash cannot overwrite these lo/hi lanes while they are in use.
const words = new Uint32Array(12);

function mixBlock(
  bytes: Uint8Array,
  offset: number,
  secretLo: number,
  secretHi: number,
  state: number,
): void {
  u64.read(words, A, bytes, offset);
  u64.xor(words, A, secretLo, secretHi);
  u64.mix(
    words,
    A,
    u64.read32(bytes, offset + 8) ^ words[state]!,
    u64.read32(bytes, offset + 12) ^ words[state + 1]!,
    UPPER,
  );
  u64.set(words, state, words[A]!, words[A + 1]!);
}

export function wyhash(bytes: Uint8Array, seed: number | bigint | undefined): bigint {
  const length = bytes.length;
  u64.hashSeed(words, STATE, seed);
  const seedLo = words[STATE]!;
  const seedHi = words[STATE + 1]!;
  u64.set(words, A, seedLo ^ SECRET0_LO, seedHi ^ SECRET0_HI);
  u64.mix(words, A, SECRET1_LO, SECRET1_HI, UPPER);
  u64.set(words, STATE, words[A]! ^ seedLo, words[A + 1]! ^ seedHi);
  u64.set(words, A, 0);
  u64.set(words, B, 0);

  if (length <= 16) {
    if (length >= 4) {
      const end = length - 4;
      const quarter = (length >> 3) << 2;
      u64.set(words, A, u64.read32(bytes, quarter), u64.read32(bytes, 0));
      u64.set(words, B, u64.read32(bytes, end - quarter), u64.read32(bytes, end));
    } else if (length > 0) {
      u64.set(words, A, (bytes[0]! << 16) | (bytes[length >> 1]! << 8) | bytes[length - 1]!);
    }
  } else {
    let offset = 0;
    if (length >= 48) {
      u64.set(words, STATE1, words[STATE]!, words[STATE + 1]!);
      u64.set(words, STATE2, words[STATE]!, words[STATE + 1]!);
      while (offset + 48 < length) {
        mixBlock(bytes, offset, SECRET1_LO, SECRET1_HI, STATE);
        mixBlock(bytes, offset + 16, 0x9c88c6e3, 0x8ebc6af0, STATE1);
        mixBlock(bytes, offset + 32, 0x75374cc3, 0x589965cc, STATE2);
        offset += 48;
      }
      u64.xor(
        words,
        STATE,
        words[STATE1]! ^ words[STATE2]!,
        words[STATE1 + 1]! ^ words[STATE2 + 1]!,
      );
    }
    while (offset + 16 < length) {
      mixBlock(bytes, offset, SECRET1_LO, SECRET1_HI, STATE);
      offset += 16;
    }
    u64.read(words, A, bytes, length - 16);
    u64.read(words, B, bytes, length - 8);
  }

  u64.xor(words, A, SECRET1_LO, SECRET1_HI);
  u64.multiply128(words, A, words[B]! ^ words[STATE]!, words[B + 1]! ^ words[STATE + 1]!, UPPER);
  u64.xor(words, A, SECRET0_LO ^ (length >>> 0), SECRET0_HI ^ Math.floor(length / 0x1_0000_0000));
  u64.xor(words, UPPER, SECRET1_LO, SECRET1_HI);
  u64.mix(words, A, words[UPPER]!, words[UPPER + 1]!, UPPER);
  return u64.toBigInt(words, A);
}
