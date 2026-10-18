const NativeUint8Array = Uint8Array;
const NativeUint32Array = Uint32Array;
const NativeDataView = DataView;
const apply = Reflect.apply;
const prototypeOf = Object.getPrototypeOf;
const own = Object.getOwnPropertyDescriptor;
const setPrototypeOf = Object.setPrototypeOf;
const freeze = Object.freeze;
const define = Object.defineProperty;
const typed = prototypeOf(NativeUint8Array.prototype) as object;
const buffer = own(typed, "buffer")!.get!;
const byteOffset = own(typed, "byteOffset")!.get!;
const byteLength = own(typed, "byteLength")!.get!;
const length = own(typed, "length")!.get!;
const set = NativeUint8Array.prototype.set;
const fill = NativeUint8Array.prototype.fill;
const subarray = NativeUint8Array.prototype.subarray;
const slice = NativeUint8Array.prototype.slice;
const getUint32 = NativeDataView.prototype.getUint32;
const setUint32 = NativeDataView.prototype.setUint32;
const setUint8 = NativeDataView.prototype.setUint8;
const setBigUint64 = NativeDataView.prototype.setBigUint64;
const hasInstance = Function.prototype[Symbol.hasInstance];

// Noble's private buffers keep their native slots but inherit only captured
// operations. Species, byte-length getters and indexed setters stay out of the guest realm.
export class HashUint8Array extends NativeUint8Array {
  override get buffer(): ArrayBuffer {
    return apply(buffer, this, []) as ArrayBuffer;
  }
  override get byteOffset(): number {
    return apply(byteOffset, this, []) as number;
  }
  override get byteLength(): number {
    return apply(byteLength, this, []) as number;
  }
  override get length(): number {
    return apply(length, this, []) as number;
  }
  override set(input: ArrayLike<number>, offset?: number): void {
    apply(set, this, [input, offset]);
  }
  override fill(value: number, start?: number, end?: number): this {
    return apply(fill, this, [value, start, end]) as this;
  }
  override subarray(begin?: number, end?: number): HashUint8Array {
    return apply(subarray, this, [begin, end]) as HashUint8Array;
  }
  override slice(start?: number, end?: number): HashUint8Array {
    return apply(slice, this, [start, end]) as HashUint8Array;
  }
}

export class HashUint32Array extends NativeUint32Array {
  override fill(value: number, start?: number, end?: number): this {
    return apply(fill, this, [value, start, end]) as this;
  }
}

export class HashDataView extends NativeDataView {
  override getUint32(offset: number, littleEndian?: boolean): number {
    return apply(getUint32, this, [offset, littleEndian]) as number;
  }
  override setUint32(offset: number, value: number, littleEndian?: boolean): void {
    apply(setUint32, this, [offset, value, littleEndian]);
  }
  override setUint8(offset: number, value: number): void {
    apply(setUint8, this, [offset, value]);
  }
  override setBigUint64(offset: number, value: bigint, littleEndian?: boolean): void {
    apply(setBigUint64, this, [offset, value, littleEndian]);
  }
}

for (const constructor of [HashUint8Array, HashUint32Array, HashDataView]) {
  setPrototypeOf(constructor.prototype, null);
  define(constructor, Symbol.hasInstance, { value: hasInstance });
  define(constructor, Symbol.species, { value: constructor });
  freeze(constructor.prototype);
  freeze(constructor);
}

export const hashMath = freeze({ __proto__: null, min: Math.min });
export const hashArrayBuffer = freeze({ __proto__: null, isView: ArrayBuffer.isView });
export const hashBigInt = BigInt;
export const hashNumber = Number;
export const hashError = Error;
export const hashTextEncoder = TextEncoder;

export function isolateHashClasses(...constructors: (abstract new (...args: never[]) => object)[]) {
  setPrototypeOf(constructors[0]!.prototype, null);
  for (let index = 0; index < constructors.length; index++) {
    freeze(constructors[index]!.prototype);
    freeze(constructors[index]!);
  }
}
