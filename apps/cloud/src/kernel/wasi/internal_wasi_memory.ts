// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { MAX_TRANSFER_BYTES } from "../KernelSyscallPort.ts";

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

  // signalbox: owner-held locks span the bounded RPCs of one guest I/O call.
  set ioOwner(_owner: object | undefined) {}

  get ioOwner(): object | undefined {
    return undefined;
  }

  // signalbox: child transfer metadata stays private to RPCs and defaults off for ordinary WASI.
  get transferOffset(): number {
    return 0;
  }

  get readOnce(): boolean {
    return false;
  }

  // signalbox: fixed child RPC payloads bound each prefix without changing original iovec validation.
  get transferLimit(): number {
    return MAX_TRANSFER_BYTES;
  }

  // signalbox: syscall memory can lend its owned input, while ordinary guest memory needs a copy.
  copyIovecs(
    vectors: readonly { pointer: number; length: number }[],
    totalLength: number,
  ): Uint8Array {
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const vector of vectors) {
      const length = Math.min(vector.length, totalLength - offset);
      result.set(this.range(vector.pointer, length), offset);
      offset += length;
      if (offset === totalLength) break;
    }
    return result;
  }

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

  // signalbox: sparse RPC output must be validated before consuming input, without allocation.
  validateOutputRange(pointer: number, length: number): void {
    this.validateRange(pointer, length);
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

  // signalbox: write-only access lets child syscall memory return exactly the bytes a call wrote.
  /** Access only bytes the caller will overwrite, so sparse syscall memory can return exact writes. */
  writeRange(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    return this.range(pointer, length);
  }

  // signalbox: the caller relinquishes read scratch so sparse RPC output can retain it directly.
  writeOwnedBytes(pointer: number, bytes: Uint8Array): void {
    this.writeRange(pointer, bytes.byteLength).set(bytes);
  }

  writeView(pointer: number, length: number): DataView {
    const bytes = this.writeRange(pointer, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(pointer: number, value: number): void {
    this.writeView(pointer, 4).setUint32(0, value >>> 0, true);
  }

  u64(pointer: number, value: bigint): void {
    this.writeView(pointer, 8).setBigUint64(0, BigInt.asUintN(64, value), true);
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

  // signalbox: directory/link windows avoid encoding complete names or targets into temporary buffers.
  writeUtf8Slice(pointer: number, value: string, offset: number, length: number): number {
    const totalBytes = utf8ByteLength(value);
    if (offset >= totalBytes || length === 0) return 0;
    const used = Math.min(length, totalBytes - offset);
    const output = this.writeRange(pointer, used);
    const end = offset + used;
    let byteOffset = 0;
    let written = 0;
    for (const encoded of utf8Chunks(value)) {
      const first = Math.max(offset, byteOffset);
      const last = Math.min(end, byteOffset + encoded.byteLength);
      if (first < last) {
        output.set(encoded.subarray(first - byteOffset, last - byteOffset), written);
        written += last - first;
      }
      byteOffset += encoded.byteLength;
      if (byteOffset >= end) break;
    }

    return written;
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
    this.range(pointers, pointerBytes);
    this.range(buffer, size);
    const pointerView = this.writeView(pointers, pointerBytes);
    const output = this.writeRange(buffer, size);
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

export function utf8ByteLength(value: string): number {
  let size = 0;
  for (const bytes of utf8Chunks(value)) size += bytes.byteLength;
  return size;
}

function* utf8Chunks(value: string) {
  const scratch = new Uint8Array(4096);
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 1024, value.length);
    const last = value.charCodeAt(end - 1);
    // Keep a surrogate pair in one encoder invocation; encodeInto replaces isolated surrogates.
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    const { read, written } = encoder.encodeInto(value.slice(offset, end), scratch);
    offset += read;
    yield scratch.subarray(0, written);
  }
}

const memoryAccessors = new WeakMap<WebAssembly.Memory, WasiMemory>();

/** Reuse a sparse syscall accessor directly or adapt an ordinary Wasm memory once. */
export function asWasiMemory(memory: WebAssembly.Memory | WasiMemory): WasiMemory {
  if (memory instanceof WasiMemory) return memory;
  let accessor = memoryAccessors.get(memory);
  if (accessor === undefined) {
    accessor = new WasiMemory();
    accessor.set(memory);
    memoryAccessors.set(memory, accessor);
  }
  return accessor;
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
