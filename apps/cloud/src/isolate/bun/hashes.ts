// Wyhash is adapted from Bun 25ef6936's src/wyhash/lib.rs; MIT, see LICENSE.bun.
// Bun cites Wang Yi's public-domain wyhash 77e50f2 as the reference for final4.
// XXH64 is adapted from Bun's scalar xxhash3.cpp and xxHash v0.8.2.
// Copyright (c) 2012-2021 Yann Collet. BSD-2-Clause; see LICENSE.xxhash.

import { hashSeed } from "./hash64.ts";
import { wyhash } from "./wyhash.ts";
import { xxHash64 } from "./xxHash64.ts";

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

export interface BunHashFunction {
  (input: BunHashInput, seed?: BunHashSeed): bigint;
  readonly wyhash: (input: BunHashInput, seed?: BunHashSeed) => bigint;
  readonly crc32: (input: BunHashInput, seed?: BunHashSeed) => number;
  readonly xxHash64: (input: BunHashInput, seed?: BunHashSeed) => bigint;
}

const wyhashMethod = (input: BunHashInput, seed?: BunHashSeed) =>
  wyhash(toBytes(input), hashSeed(seed));
const crc32Method = (input: BunHashInput, seed?: BunHashSeed) =>
  crc32(toBytes(input), seedToU64(seed));
const xxHash64Method = (input: BunHashInput, seed?: BunHashSeed) =>
  xxHash64(toBytes(input), hashSeed(seed));

export const bunHash: BunHashFunction = Object.assign(wyhashMethod, {
  wyhash: wyhashMethod,
  crc32: crc32Method,
  xxHash64: xxHash64Method,
});
