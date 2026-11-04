// XXH64 is adapted from Bun's scalar xxhash3.cpp and xxHash v0.8.2.
// Copyright (c) 2012-2021 Yann Collet. BSD-2-Clause; see LICENSE.xxhash.

import { Hash64 } from "./hash64.ts";

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

function round(accumulator: Hash64, lane: Hash64): void {
  lane.multiply(PRIME2_LO, PRIME2_HI);
  accumulator.add(lane.lo, lane.hi).rotateLeft(31).multiply(PRIME1_LO, PRIME1_HI);
}

function merge(hash: Hash64, value: Hash64, lane: Hash64): void {
  lane
    .set(value.lo, value.hi)
    .multiply(PRIME2_LO, PRIME2_HI)
    .rotateLeft(31)
    .multiply(PRIME1_LO, PRIME1_HI);
  hash.xor(lane.lo, lane.hi).multiply(PRIME1_LO, PRIME1_HI).add(PRIME4_LO, PRIME4_HI);
}

export function xxHash64(bytes: Uint8Array, seed: Hash64): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  const hash = new Hash64(seed.lo, seed.hi);
  const lane = new Hash64();
  let offset = 0;

  if (length >= 32) {
    const v1 = new Hash64(seed.lo, seed.hi).add(PRIME1_LO, PRIME1_HI).add(PRIME2_LO, PRIME2_HI);
    const v2 = new Hash64(seed.lo, seed.hi).add(PRIME2_LO, PRIME2_HI);
    const v3 = new Hash64(seed.lo, seed.hi);
    const v4 = new Hash64(seed.lo, seed.hi).add(-PRIME1_LO, ~PRIME1_HI);
    while (offset <= length - 32) {
      round(v1, lane.read(view, offset));
      round(v2, lane.read(view, offset + 8));
      round(v3, lane.read(view, offset + 16));
      round(v4, lane.read(view, offset + 24));
      offset += 32;
    }
    hash.set(v1.lo, v1.hi).rotateLeft(1);
    lane.set(v2.lo, v2.hi).rotateLeft(7);
    hash.add(lane.lo, lane.hi);
    lane.set(v3.lo, v3.hi).rotateLeft(12);
    hash.add(lane.lo, lane.hi);
    lane.set(v4.lo, v4.hi).rotateLeft(18);
    hash.add(lane.lo, lane.hi);
    merge(hash, v1, lane);
    merge(hash, v2, lane);
    merge(hash, v3, lane);
    merge(hash, v4, lane);
  } else {
    hash.add(PRIME5_LO, PRIME5_HI);
  }

  hash.add(length >>> 0, Math.floor(length / 0x1_0000_0000));
  while (offset <= length - 8) {
    lane
      .read(view, offset)
      .multiply(PRIME2_LO, PRIME2_HI)
      .rotateLeft(31)
      .multiply(PRIME1_LO, PRIME1_HI);
    hash
      .xor(lane.lo, lane.hi)
      .rotateLeft(27)
      .multiply(PRIME1_LO, PRIME1_HI)
      .add(PRIME4_LO, PRIME4_HI);
    offset += 8;
  }
  if (offset <= length - 4) {
    lane.set(view.getUint32(offset, true)).multiply(PRIME1_LO, PRIME1_HI);
    hash
      .xor(lane.lo, lane.hi)
      .rotateLeft(23)
      .multiply(PRIME2_LO, PRIME2_HI)
      .add(PRIME3_LO, PRIME3_HI);
    offset += 4;
  }
  while (offset < length) {
    lane.set(bytes[offset]!).multiply(PRIME5_LO, PRIME5_HI);
    hash.xor(lane.lo, lane.hi).rotateLeft(11).multiply(PRIME1_LO, PRIME1_HI);
    offset++;
  }
  return hash
    .xorShiftRight(33)
    .multiply(PRIME2_LO, PRIME2_HI)
    .xorShiftRight(29)
    .multiply(PRIME3_LO, PRIME3_HI)
    .xorShiftRight(32)
    .toBigInt();
}
