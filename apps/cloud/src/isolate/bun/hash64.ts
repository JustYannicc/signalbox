const WORD = 0x1_0000_0000;

function multiplyHigh32(a: number, b: number): number {
  const middle =
    (Math.imul(a >>> 16, b & 0xffff) >>> 0) +
    (Math.imul(a & 0xffff, b >>> 16) >>> 0) +
    ((Math.imul(a & 0xffff, b & 0xffff) >>> 0) >>> 16);
  return (Math.imul(a >>> 16, b >>> 16) + Math.floor(middle / 0x1_0000)) >>> 0;
}

// Mutable words keep block processing from allocating temporary pairs or BigInts.
export class Hash64 {
  lo: number;
  hi: number;

  constructor(lo = 0, hi = 0) {
    this.lo = lo >>> 0;
    this.hi = hi >>> 0;
  }

  set(lo: number, hi = 0): this {
    this.lo = lo >>> 0;
    this.hi = hi >>> 0;
    return this;
  }

  read(view: DataView, offset: number): this {
    return this.set(view.getUint32(offset, true), view.getUint32(offset + 4, true));
  }

  add(lo: number, hi = 0): this {
    const sum = this.lo + (lo >>> 0);
    this.hi = (this.hi + (hi >>> 0) + Math.floor(sum / WORD)) >>> 0;
    this.lo = sum >>> 0;
    return this;
  }

  xor(lo: number, hi: number): this {
    return this.set(this.lo ^ lo, this.hi ^ hi);
  }

  rotateLeft(bits: number): this {
    return this.set(
      (this.lo << bits) | (this.hi >>> (32 - bits)),
      (this.hi << bits) | (this.lo >>> (32 - bits)),
    );
  }

  xorShiftRight(bits: number): this {
    if (bits >= 32) return this.xor(this.hi >>> (bits - 32), 0);
    return this.xor((this.lo >>> bits) | (this.hi << (32 - bits)), this.hi >>> bits);
  }

  multiply(lo: number, hi: number): this {
    return this.set(
      Math.imul(this.lo, lo),
      multiplyHigh32(this.lo, lo) + Math.imul(this.hi, lo) + Math.imul(this.lo, hi),
    );
  }

  multiply128(lo: number, hi: number, upper: Hash64): this {
    lo >>>= 0;
    hi >>>= 0;
    const middle =
      multiplyHigh32(this.lo, lo) + (Math.imul(this.lo, hi) >>> 0) + (Math.imul(this.hi, lo) >>> 0);
    const high =
      multiplyHigh32(this.lo, hi) +
      multiplyHigh32(this.hi, lo) +
      (Math.imul(this.hi, hi) >>> 0) +
      Math.floor(middle / WORD);
    upper.set(high, multiplyHigh32(this.hi, hi) + Math.floor(high / WORD));
    return this.set(Math.imul(this.lo, lo), middle);
  }

  mix(lo: number, hi: number, upper: Hash64): this {
    this.multiply128(lo, hi, upper);
    return this.xor(upper.lo, upper.hi);
  }

  toBigInt(): bigint {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }
}

export function hashSeed(seed: number | bigint | undefined): Hash64 {
  if (typeof seed === "bigint") {
    return new Hash64(Number(seed & 0xffff_ffffn), Number((seed >> 32n) & 0xffff_ffffn));
  }
  if (seed === undefined || Number.isNaN(seed) || seed === -Infinity) return new Hash64();
  if (seed >= 2 ** 64) return new Hash64(0xffff_ffff, 0xffff_ffff);
  const value = Math.trunc(seed);
  return new Hash64(value >>> 0, Math.floor(value / WORD) >>> 0);
}
