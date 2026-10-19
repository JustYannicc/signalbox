// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const EFAULT = 21;
const EILSEQ = 25;
const EINVAL = 28;
const MAX_UINT32 = 0xffff_ffff;
const MAX_IOVECS = 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export class WasiError extends Error {
  readonly errno: number;

  constructor(errno: number) {
    super(`WASI error: ${errno}`);
    this.name = "WasiError";
    this.errno = errno;
  }
}

export class WasiExit extends Error {
  readonly code: number;

  constructor(code: number) {
    const unsignedCode = code >>> 0;
    super(`WASI process exited with code ${unsignedCode}`);
    this.name = "WasiExit";
    this.code = unsignedCode;
  }
}

export class WasiMemory {
  #memory: WebAssembly.Memory | undefined;

  set(memory: WebAssembly.Memory): void {
    this.#memory = memory;
  }

  get memory(): WebAssembly.Memory {
    if (this.#memory === undefined) {
      throw new WasiError(EFAULT);
    }
    return this.#memory;
  }

  get byteLength(): number {
    return this.memory.buffer.byteLength;
  }

  validateRange(pointer: number, length: number): void {
    if ((pointer >>> 0) + (length >>> 0) > this.byteLength) throw new WasiError(EFAULT);
  }

  range(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    const start = pointer >>> 0;
    const size = length >>> 0;
    const buffer = this.memory.buffer;
    const end = start + size;
    if (end > buffer.byteLength) {
      throw new WasiError(EFAULT);
    }
    return new Uint8Array(buffer, start, size);
  }

  view(pointer: number, length: number): DataView {
    const bytes = this.range(pointer, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(pointer: number, value: number): void {
    this.view(pointer, 4).setUint32(0, value >>> 0, true);
  }

  u64(pointer: number, value: bigint): void {
    this.view(pointer, 8).setBigUint64(0, BigInt.asUintN(64, value), true);
  }

  readU32(pointer: number): number {
    return this.view(pointer, 4).getUint32(0, true);
  }

  bytes(pointer: number, length: number): Uint8Array {
    return this.range(pointer, length).slice();
  }

  string(pointer: number, length: number): string {
    const input = this.bytes(pointer, length);
    let value: string;
    try {
      value = decoder.decode(input);
    } catch {
      throw new WasiError(EILSEQ);
    }
    if (value.includes("\0")) {
      throw new WasiError(EINVAL);
    }
    return value;
  }

  iovecs(pointer: number, count: number): Array<{ pointer: number; length: number }> {
    const itemCount = count >>> 0;
    if (itemCount > MAX_IOVECS) {
      throw new WasiError(EINVAL);
    }

    const table = this.view(pointer, itemCount * 8);
    const result: Array<{ pointer: number; length: number }> = [];
    for (let index = 0; index < itemCount; index++) {
      const entryOffset = index * 8;
      const entryPointer = table.getUint32(entryOffset, true);
      const entryLength = table.getUint32(entryOffset + 4, true);
      this.validateRange(entryPointer, entryLength);
      result.push({ pointer: entryPointer, length: entryLength });
    }
    return result;
  }

  writeStrings(strings: string[], pointers: number, buffer: number): void {
    const encoded = strings.map((value) => {
      if (value.includes("\0")) {
        throw new WasiError(EINVAL);
      }
      return encoder.encode(value);
    });
    const { size } = sizeEncodedStrings(encoded);
    const pointerBytes = strings.length * 4;
    if (pointerBytes > MAX_UINT32) {
      throw new WasiError(EFAULT);
    }

    // Validate both destination ranges before changing guest memory.
    const pointerView = this.view(pointers, pointerBytes);
    const output = this.range(buffer, size);
    let outputOffset = 0;
    const firstString = buffer >>> 0;
    for (const [index, bytes] of encoded.entries()) {
      pointerView.setUint32(index * 4, firstString + outputOffset, true);
      output.set(bytes, outputOffset);
      outputOffset += bytes.byteLength;
      output[outputOffset++] = 0;
    }
  }

  stringSizes(strings: string[]): { count: number; size: number } {
    return sizeEncodedStrings(strings.map((value) => encoder.encode(value)));
  }
}

function sizeEncodedStrings(strings: Uint8Array[]): {
  count: number;
  size: number;
} {
  let size = 0;
  for (const value of strings) {
    size += value.byteLength + 1;
    if (size > MAX_UINT32) {
      throw new WasiError(EFAULT);
    }
  }
  return { count: strings.length, size };
}
