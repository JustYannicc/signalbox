// XXH64 is adapted from Bun's scalar xxhash3.cpp and xxHash v0.8.2.
// Copyright (c) 2012-2021 Yann Collet. BSD-2-Clause; see LICENSE.xxhash.

import * as u64 from "./hash64.ts";

const PRIME1_LO = 0x85ebca87;
const PRIME1_HI = 0x9e3779b1;
const PRIME2_LO = 0x27d4eb4f;
const PRIME2_HI = 0xc2b2ae3d;
const PRIME3_LO = 0x9e3779f9;
const PRIME3_HI = 0x165667b1;
const PRIME4_LO = 0xc2b2ae63;
const PRIME4_HI = 0x85ebca77;
const PRIME5_LO = 0x165667c5;
const PRIME5_HI = 0x27d4eb2f;
const HASH = 0;
const LANE = 2;
const V1 = 4;
const V2 = 6;
const V3 = 8;
const V4 = 10;
// Inputs are normalized before entry; hashing is synchronous and calls no user code,
// so a nested hash cannot overwrite these lo/hi lanes while they are in use.
const words = new Uint32Array(12);

function round(accumulator: number): void {
  u64.multiply(words, LANE, PRIME2_LO, PRIME2_HI);
  u64.add(words, accumulator, words[LANE]!, words[LANE + 1]!);
  u64.rotateLeft(words, accumulator, 31);
  u64.multiply(words, accumulator, PRIME1_LO, PRIME1_HI);
}

function merge(value: number): void {
  u64.set(words, LANE, words[value]!, words[value + 1]!);
  u64.multiply(words, LANE, PRIME2_LO, PRIME2_HI);
  u64.rotateLeft(words, LANE, 31);
  u64.multiply(words, LANE, PRIME1_LO, PRIME1_HI);
  u64.xor(words, HASH, words[LANE]!, words[LANE + 1]!);
  u64.multiply(words, HASH, PRIME1_LO, PRIME1_HI);
  u64.add(words, HASH, PRIME4_LO, PRIME4_HI);
}

export function xxHash64(bytes: Uint8Array, seed: number | bigint | undefined): bigint {
  const length = bytes.length;
  u64.hashSeed(words, HASH, seed);
  let offset = 0;

  if (length >= 32) {
    u64.set(words, V1, words[HASH]!, words[HASH + 1]!);
    u64.add(words, V1, PRIME1_LO, PRIME1_HI);
    u64.add(words, V1, PRIME2_LO, PRIME2_HI);
    u64.set(words, V2, words[HASH]!, words[HASH + 1]!);
    u64.add(words, V2, PRIME2_LO, PRIME2_HI);
    u64.set(words, V3, words[HASH]!, words[HASH + 1]!);
    u64.set(words, V4, words[HASH]!, words[HASH + 1]!);
    u64.add(words, V4, -PRIME1_LO, ~PRIME1_HI);
    while (offset <= length - 32) {
      u64.read(words, LANE, bytes, offset);
      round(V1);
      u64.read(words, LANE, bytes, offset + 8);
      round(V2);
      u64.read(words, LANE, bytes, offset + 16);
      round(V3);
      u64.read(words, LANE, bytes, offset + 24);
      round(V4);
      offset += 32;
    }
    u64.set(words, HASH, words[V1]!, words[V1 + 1]!);
    u64.rotateLeft(words, HASH, 1);
    u64.set(words, LANE, words[V2]!, words[V2 + 1]!);
    u64.rotateLeft(words, LANE, 7);
    u64.add(words, HASH, words[LANE]!, words[LANE + 1]!);
    u64.set(words, LANE, words[V3]!, words[V3 + 1]!);
    u64.rotateLeft(words, LANE, 12);
    u64.add(words, HASH, words[LANE]!, words[LANE + 1]!);
    u64.set(words, LANE, words[V4]!, words[V4 + 1]!);
    u64.rotateLeft(words, LANE, 18);
    u64.add(words, HASH, words[LANE]!, words[LANE + 1]!);
    merge(V1);
    merge(V2);
    merge(V3);
    merge(V4);
  } else {
    u64.add(words, HASH, PRIME5_LO, PRIME5_HI);
  }

  u64.add(words, HASH, length >>> 0, Math.floor(length / 0x1_0000_0000));
  while (offset <= length - 8) {
    u64.read(words, LANE, bytes, offset);
    u64.multiply(words, LANE, PRIME2_LO, PRIME2_HI);
    u64.rotateLeft(words, LANE, 31);
    u64.multiply(words, LANE, PRIME1_LO, PRIME1_HI);
    u64.xor(words, HASH, words[LANE]!, words[LANE + 1]!);
    u64.rotateLeft(words, HASH, 27);
    u64.multiply(words, HASH, PRIME1_LO, PRIME1_HI);
    u64.add(words, HASH, PRIME4_LO, PRIME4_HI);
    offset += 8;
  }
  if (offset <= length - 4) {
    u64.set(words, LANE, u64.read32(bytes, offset));
    u64.multiply(words, LANE, PRIME1_LO, PRIME1_HI);
    u64.xor(words, HASH, words[LANE]!, words[LANE + 1]!);
    u64.rotateLeft(words, HASH, 23);
    u64.multiply(words, HASH, PRIME2_LO, PRIME2_HI);
    u64.add(words, HASH, PRIME3_LO, PRIME3_HI);
    offset += 4;
  }
  while (offset < length) {
    u64.set(words, LANE, bytes[offset]!);
    u64.multiply(words, LANE, PRIME5_LO, PRIME5_HI);
    u64.xor(words, HASH, words[LANE]!, words[LANE + 1]!);
    u64.rotateLeft(words, HASH, 11);
    u64.multiply(words, HASH, PRIME1_LO, PRIME1_HI);
    offset++;
  }
  u64.xorShiftRight(words, HASH, 33);
  u64.multiply(words, HASH, PRIME2_LO, PRIME2_HI);
  u64.xorShiftRight(words, HASH, 29);
  u64.multiply(words, HASH, PRIME3_LO, PRIME3_HI);
  u64.xorShiftRight(words, HASH, 32);
  return u64.toBigInt(words, HASH);
}
