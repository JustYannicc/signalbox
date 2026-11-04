const WORD = 0x1_0000_0000;
// Synchronous primitive conversion cannot re-enter; reuse the view to avoid temporary BigInts.
const conversion = new DataView(new ArrayBuffer(8));

function multiplyHigh32(a: number, b: number): number {
  const middle =
    (Math.imul(a >>> 16, b & 0xffff) >>> 0) +
    (Math.imul(a & 0xffff, b >>> 16) >>> 0) +
    ((Math.imul(a & 0xffff, b & 0xffff) >>> 0) >>> 16);
  return (Math.imul(a >>> 16, b >>> 16) + Math.floor(middle / 0x1_0000)) >>> 0;
}

export function set(words: Uint32Array, at: number, lo: number, hi = 0): void {
  words[at] = lo;
  words[at + 1] = hi;
}

export function read32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

export function read(words: Uint32Array, at: number, bytes: Uint8Array, offset: number): void {
  set(words, at, read32(bytes, offset), read32(bytes, offset + 4));
}

export function add(words: Uint32Array, at: number, lo: number, hi = 0): void {
  const sum = words[at]! + (lo >>> 0);
  words[at + 1] = words[at + 1]! + (hi >>> 0) + Math.floor(sum / WORD);
  words[at] = sum;
}

export function xor(words: Uint32Array, at: number, lo: number, hi: number): void {
  set(words, at, words[at]! ^ lo, words[at + 1]! ^ hi);
}

export function rotateLeft(words: Uint32Array, at: number, bits: number): void {
  const lo = words[at]!;
  const hi = words[at + 1]!;
  set(words, at, (lo << bits) | (hi >>> (32 - bits)), (hi << bits) | (lo >>> (32 - bits)));
}

export function xorShiftRight(words: Uint32Array, at: number, bits: number): void {
  const hi = words[at + 1]!;
  if (bits >= 32) return xor(words, at, hi >>> (bits - 32), 0);
  xor(words, at, (words[at]! >>> bits) | (hi << (32 - bits)), hi >>> bits);
}

export function multiply(words: Uint32Array, at: number, lo: number, hi: number): void {
  const a = words[at]!;
  set(
    words,
    at,
    Math.imul(a, lo),
    multiplyHigh32(a, lo) + Math.imul(words[at + 1]!, lo) + Math.imul(a, hi),
  );
}

export function multiply128(
  words: Uint32Array,
  at: number,
  lo: number,
  hi: number,
  upper: number,
): void {
  const a = words[at]!;
  const b = words[at + 1]!;
  lo >>>= 0;
  hi >>>= 0;
  const middle = multiplyHigh32(a, lo) + (Math.imul(a, hi) >>> 0) + (Math.imul(b, lo) >>> 0);
  const high =
    multiplyHigh32(a, hi) +
    multiplyHigh32(b, lo) +
    (Math.imul(b, hi) >>> 0) +
    Math.floor(middle / WORD);
  set(words, upper, high, multiplyHigh32(b, hi) + Math.floor(high / WORD));
  set(words, at, Math.imul(a, lo), middle);
}

export function mix(words: Uint32Array, at: number, lo: number, hi: number, upper: number): void {
  multiply128(words, at, lo, hi, upper);
  xor(words, at, words[upper]!, words[upper + 1]!);
}

export function toBigInt(words: Uint32Array, at: number): bigint {
  conversion.setUint32(0, words[at]!, true);
  conversion.setUint32(4, words[at + 1]!, true);
  return conversion.getBigUint64(0, true);
}

export function hashSeed(words: Uint32Array, at: number, seed: number | bigint | undefined): void {
  if (typeof seed === "bigint") {
    conversion.setBigUint64(0, seed, true);
    set(words, at, conversion.getUint32(0, true), conversion.getUint32(4, true));
  } else if (seed === undefined || Number.isNaN(seed) || seed === -Infinity) {
    set(words, at, 0);
  } else if (seed >= 2 ** 64) {
    set(words, at, 0xffff_ffff, 0xffff_ffff);
  } else {
    const value = Math.trunc(seed);
    set(words, at, value >>> 0, Math.floor(value / WORD) >>> 0);
  }
}
