import type { KernelMemoryRegion } from "../../kernel/KernelSyscallPort.ts";

const MAX_IOVECS = 1024;

interface MemoryRange {
  readonly start: number;
  readonly end: number;
}

/** Tracks only guest ranges named by one WASI call's ABI. */
export class MemoryRegions {
  readonly #memory: WebAssembly.Memory;
  readonly #ranges: MemoryRange[] = [];

  constructor(memory: WebAssembly.Memory) {
    this.#memory = memory;
  }

  add(pointer: number, length: number): void {
    const start = pointer >>> 0;
    const size = length >>> 0;
    const end = start + size;
    if (size === 0 || end > this.#memory.buffer.byteLength) return;
    this.#ranges.push({ start, end });
  }

  addIovecs(pointer: number, count: number): void {
    const itemCount = count >>> 0;
    if (itemCount > MAX_IOVECS) return;

    const tableSize = itemCount * 8;
    const start = pointer >>> 0;
    const end = start + tableSize;
    if (end > this.#memory.buffer.byteLength) return;

    this.add(pointer, tableSize);
    const table = new DataView(this.#memory.buffer, start, tableSize);
    for (let index = 0; index < itemCount; index++) {
      const offset = index * 8;
      this.add(table.getUint32(offset, true), table.getUint32(offset + 4, true));
    }
  }

  snapshot(): KernelMemoryRegion[] {
    const buffer = this.#memory.buffer;
    return this.#mergedRanges().map(({ start, end }) => ({
      pointer: start,
      bytes: new Uint8Array(buffer, start, end - start).slice(),
    }));
  }

  apply(regions: readonly KernelMemoryRegion[]): void {
    const buffer = this.#memory.buffer;
    const allowed = this.#mergedRanges();
    let previousEnd = 0;

    for (const region of regions) {
      const { pointer, bytes } = region;
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("Invalid syscall memory response regions");
      }
      const end = pointer + bytes.byteLength;
      if (
        !Number.isSafeInteger(pointer) ||
        pointer < previousEnd ||
        pointer < 0 ||
        end > buffer.byteLength ||
        !allowed.some((range) => pointer >= range.start && end <= range.end)
      ) {
        throw new TypeError("Invalid syscall memory response regions");
      }
      new Uint8Array(buffer, pointer, bytes.byteLength).set(bytes);
      previousEnd = end;
    }
  }

  #mergedRanges(): MemoryRange[] {
    const sorted = [...this.#ranges].sort((left, right) => left.start - right.start);
    const merged: MemoryRange[] = [];

    for (const range of sorted) {
      const previous = merged.at(-1);
      if (previous === undefined || range.start > previous.end) {
        merged.push({ ...range });
      } else if (range.end > previous.end) {
        merged[merged.length - 1] = { start: previous.start, end: range.end };
      }
    }
    return merged;
  }
}
