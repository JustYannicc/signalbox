// Wyhash is adapted from Bun 25ef6936's src/wyhash/lib.rs; MIT, see LICENSE.bun.
// Bun cites Wang Yi's public-domain wyhash 77e50f2 as the reference for final4.
// XXH64 is adapted from Bun's scalar xxhash3.cpp and xxHash v0.8.2.
// Copyright (c) 2012-2021 Yann Collet. BSD-2-Clause; see LICENSE.xxhash.

export type BunHashInput = string | ArrayBuffer | ArrayBufferView;
export type BunHashSeed = number | bigint;

const U32_MASK = 0xffff_ffff;
const U64_MASK = 0xffff_ffff_ffff_ffffn;
const textEncoder = new TextEncoder();

/** Return the exact byte window represented by a Bun hash input. */
export function toBytes(input: BunHashInput): Uint8Array {
  if (typeof input === "string") return textEncoder.encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Bun.hash input must be a string, ArrayBuffer, or ArrayBufferView");
}

function seedToU64(seed: BunHashSeed | undefined): bigint {
  if (seed === undefined) return 0n;
  if (typeof seed === "bigint") return BigInt.asUintN(64, seed);
  if (Number.isNaN(seed) || seed === -Infinity || seed === 0) return 0n;
  if (seed === Infinity || seed >= 2 ** 64) return U64_MASK;
  return BigInt.asUintN(64, BigInt(Math.trunc(seed)));
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU64(view: DataView, offset: number): bigint {
  return BigInt(view.getUint32(offset, true)) | (BigInt(view.getUint32(offset + 4, true)) << 32n);
}

function readU32(view: DataView, offset: number): bigint {
  return BigInt(view.getUint32(offset, true));
}

function mum(a: bigint, b: bigint): bigint {
  const product = a * b;
  return ((product & U64_MASK) ^ (product >> 64n)) & U64_MASK;
}

function wyhashFinal(a: bigint, b: bigint, state: bigint, length: bigint): bigint {
  const product = (a ^ WY_SECRET[1]) * (b ^ state);
  return mum(
    (product & U64_MASK) ^ WY_SECRET[0] ^ length,
    ((product >> 64n) ^ WY_SECRET[1]) & U64_MASK,
  );
}

const WY_SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
] as const;

function wyhash(bytes: Uint8Array, seed: bigint): bigint {
  const view = dataView(bytes);
  const length = bytes.length;
  const len = BigInt(length) & U64_MASK;
  let a = 0n;
  let b = 0n;

  const mix = (left: bigint, right: bigint) => mum(left, right);
  const initial = seed ^ mix(seed ^ WY_SECRET[0], WY_SECRET[1]);

  if (length <= 16) {
    if (length >= 4) {
      const end = length - 4;
      const quarter = (length >> 3) << 2;
      a = (readU32(view, 0) << 32n) | readU32(view, quarter);
      b = (readU32(view, end) << 32n) | readU32(view, end - quarter);
    } else if (length > 0) {
      a =
        (BigInt(bytes[0]!) << 16n) |
        (BigInt(bytes[length >> 1]!) << 8n) |
        BigInt(bytes[length - 1]!);
    }
    return wyhashFinal(a, b, initial, len);
  }

  const state = [initial, initial, initial];
  let offset = 0;
  if (length >= 48) {
    while (offset + 48 < length) {
      state[0] = mix(readU64(view, offset) ^ WY_SECRET[1], readU64(view, offset + 8) ^ state[0]!);
      state[1] = mix(
        readU64(view, offset + 16) ^ WY_SECRET[2],
        readU64(view, offset + 24) ^ state[1]!,
      );
      state[2] = mix(
        readU64(view, offset + 32) ^ WY_SECRET[3],
        readU64(view, offset + 40) ^ state[2]!,
      );
      offset += 48;
    }
    state[0] = state[0]! ^ state[1]! ^ state[2]!;
  }

  while (offset + 16 < length) {
    state[0] = mix(readU64(view, offset) ^ WY_SECRET[1], readU64(view, offset + 8) ^ state[0]!);
    offset += 16;
  }
  a = readU64(view, length - 16);
  b = readU64(view, length - 8);
  return wyhashFinal(a, b, state[0]!, len);
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array, seed: bigint): number {
  let crc = (Number(seed & BigInt(U32_MASK)) ^ U32_MASK) >>> 0;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ U32_MASK) >>> 0;
}

const XX_PRIME1 = 11_400_714_785_074_694_791n;
const XX_PRIME2 = 14_029_467_366_897_019_727n;
const XX_PRIME3 = 1_609_587_929_392_839_161n;
const XX_PRIME4 = 9_650_029_242_287_828_579n;
const XX_PRIME5 = 2_870_177_450_012_600_261n;

function rotateLeft64(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & U64_MASK;
}

function xxRound(accumulator: bigint, input: bigint): bigint {
  return (rotateLeft64((accumulator + input * XX_PRIME2) & U64_MASK, 31n) * XX_PRIME1) & U64_MASK;
}

function xxMergeRound(accumulator: bigint, value: bigint): bigint {
  return ((accumulator ^ xxRound(0n, value)) * XX_PRIME1 + XX_PRIME4) & U64_MASK;
}

function xxHash64(bytes: Uint8Array, seed: bigint): bigint {
  const view = dataView(bytes);
  const length = bytes.length;
  let offset = 0;
  let hash: bigint;

  if (length >= 32) {
    let v1 = (seed + XX_PRIME1 + XX_PRIME2) & U64_MASK;
    let v2 = (seed + XX_PRIME2) & U64_MASK;
    let v3 = seed;
    let v4 = (seed - XX_PRIME1) & U64_MASK;

    while (offset <= length - 32) {
      v1 = xxRound(v1, readU64(view, offset));
      v2 = xxRound(v2, readU64(view, offset + 8));
      v3 = xxRound(v3, readU64(view, offset + 16));
      v4 = xxRound(v4, readU64(view, offset + 24));
      offset += 32;
    }

    hash =
      (rotateLeft64(v1, 1n) +
        rotateLeft64(v2, 7n) +
        rotateLeft64(v3, 12n) +
        rotateLeft64(v4, 18n)) &
      U64_MASK;
    hash = xxMergeRound(hash, v1);
    hash = xxMergeRound(hash, v2);
    hash = xxMergeRound(hash, v3);
    hash = xxMergeRound(hash, v4);
  } else {
    hash = (seed + XX_PRIME5) & U64_MASK;
  }

  hash = (hash + BigInt(length)) & U64_MASK;
  while (offset <= length - 8) {
    const lane = xxRound(0n, readU64(view, offset));
    hash = (rotateLeft64(hash ^ lane, 27n) * XX_PRIME1 + XX_PRIME4) & U64_MASK;
    offset += 8;
  }
  if (offset <= length - 4) {
    hash =
      (rotateLeft64(hash ^ ((readU32(view, offset) * XX_PRIME1) & U64_MASK), 23n) * XX_PRIME2 +
        XX_PRIME3) &
      U64_MASK;
    offset += 4;
  }
  while (offset < length) {
    hash =
      (rotateLeft64(hash ^ ((BigInt(bytes[offset]!) * XX_PRIME5) & U64_MASK), 11n) * XX_PRIME1) &
      U64_MASK;
    offset++;
  }

  hash ^= hash >> 33n;
  hash = (hash * XX_PRIME2) & U64_MASK;
  hash ^= hash >> 29n;
  hash = (hash * XX_PRIME3) & U64_MASK;
  return (hash ^ (hash >> 32n)) & U64_MASK;
}

export interface BunHashFunction {
  (input: BunHashInput, seed?: BunHashSeed): bigint;
  readonly wyhash: (input: BunHashInput, seed?: BunHashSeed) => bigint;
  readonly crc32: (input: BunHashInput, seed?: BunHashSeed) => number;
  readonly xxHash64: (input: BunHashInput, seed?: BunHashSeed) => bigint;
}

const wyhashMethod = (input: BunHashInput, seed?: BunHashSeed) =>
  wyhash(toBytes(input), seedToU64(seed));
const crc32Method = (input: BunHashInput, seed?: BunHashSeed) =>
  crc32(toBytes(input), seedToU64(seed));
const xxHash64Method = (input: BunHashInput, seed?: BunHashSeed) =>
  xxHash64(toBytes(input), seedToU64(seed));

export const bunHash: BunHashFunction = Object.assign(wyhashMethod, {
  wyhash: wyhashMethod,
  crc32: crc32Method,
  xxHash64: xxHash64Method,
});
