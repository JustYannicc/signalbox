// Wyhash is adapted from Bun 25ef6936's src/wyhash/lib.rs; MIT, see LICENSE.bun.
// Bun cites Wang Yi's public-domain wyhash 77e50f2 as the reference for final4.

import { Hash64 } from "./hash64.ts";

const SECRET0_LO = 0x78bd642f;
const SECRET0_HI = 0xa0761d64;
const SECRET1_LO = 0xa0b428db;
const SECRET1_HI = 0xe7037ed1;

function mixBlock(
  view: DataView,
  offset: number,
  secretLo: number,
  secretHi: number,
  state: Hash64,
  lane: Hash64,
  upper: Hash64,
): void {
  lane
    .read(view, offset)
    .xor(secretLo, secretHi)
    .mix(
      view.getUint32(offset + 8, true) ^ state.lo,
      view.getUint32(offset + 12, true) ^ state.hi,
      upper,
    );
  state.set(lane.lo, lane.hi);
}

export function wyhash(bytes: Uint8Array, seed: Hash64): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  const upper = new Hash64();
  const a = new Hash64(seed.lo ^ SECRET0_LO, seed.hi ^ SECRET0_HI);
  a.mix(SECRET1_LO, SECRET1_HI, upper).xor(seed.lo, seed.hi);
  const state = new Hash64(a.lo, a.hi);
  const b = new Hash64();
  a.set(0);

  if (length <= 16) {
    if (length >= 4) {
      const end = length - 4;
      const quarter = (length >> 3) << 2;
      a.set(view.getUint32(quarter, true), view.getUint32(0, true));
      b.set(view.getUint32(end - quarter, true), view.getUint32(end, true));
    } else if (length > 0) {
      a.set((bytes[0]! << 16) | (bytes[length >> 1]! << 8) | bytes[length - 1]!);
    }
  } else {
    let offset = 0;
    if (length >= 48) {
      const state1 = new Hash64(state.lo, state.hi);
      const state2 = new Hash64(state.lo, state.hi);
      while (offset + 48 < length) {
        mixBlock(view, offset, SECRET1_LO, SECRET1_HI, state, a, upper);
        mixBlock(view, offset + 16, 0x9c88c6e3, 0x8ebc6af0, state1, a, upper);
        mixBlock(view, offset + 32, 0x75374cc3, 0x589965cc, state2, a, upper);
        offset += 48;
      }
      state.xor(state1.lo ^ state2.lo, state1.hi ^ state2.hi);
    }
    while (offset + 16 < length) {
      mixBlock(view, offset, SECRET1_LO, SECRET1_HI, state, a, upper);
      offset += 16;
    }
    a.read(view, length - 16);
    b.read(view, length - 8);
  }

  a.xor(SECRET1_LO, SECRET1_HI).multiply128(b.lo ^ state.lo, b.hi ^ state.hi, upper);
  a.xor(SECRET0_LO ^ (length >>> 0), SECRET0_HI ^ Math.floor(length / 0x1_0000_0000));
  upper.xor(SECRET1_LO, SECRET1_HI);
  return a.mix(upper.lo, upper.hi, upper).toBigInt();
}
