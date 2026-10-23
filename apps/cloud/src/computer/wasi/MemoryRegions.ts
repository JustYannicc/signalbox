import type { KernelMemoryRegion } from "../../kernel/KernelSyscallPort.ts";

const MAX_IOVECS = 1024;
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;

interface MemoryRange {
  readonly start: number;
  readonly end: number;
  readonly direction: NonNullable<KernelMemoryRegion["direction"]>;
}

/** Tracks only guest ranges named by one WASI call's ABI. */
export class MemoryRegions {
  readonly #memory: WebAssembly.Memory;
  readonly #ranges: MemoryRange[] = [];
  readonly transferLimit: number;

  constructor(memory: WebAssembly.Memory, transferLimit = MAX_TRANSFER_BYTES) {
    this.#memory = memory;
    this.transferLimit = transferLimit;
  }

  add(pointer: number, length: number, direction: MemoryRange["direction"] = "inout"): void {
    const start = pointer >>> 0;
    const size = length >>> 0;
    const end = start + size;
    if (size === 0 || end > this.#memory.buffer.byteLength) return;
    this.#ranges.push({ start, end, direction });
  }

  addIovecs(pointer: number, count: number, direction: MemoryRange["direction"] = "inout"): void {
    const itemCount = count >>> 0;
    if (itemCount > MAX_IOVECS) return;

    const tableSize = itemCount * 8;
    const start = pointer >>> 0;
    const end = start + tableSize;
    if (end > this.#memory.buffer.byteLength) return;

    this.add(pointer, tableSize, "in");
    const table = new DataView(this.#memory.buffer, start, tableSize);
    let remaining = this.transferLimit;
    for (let index = 0; index < itemCount; index++) {
      const offset = index * 8;
      const pointer = table.getUint32(offset, true);
      const length = table.getUint32(offset + 4, true);
      const copied = Math.min(remaining, length);
      // The owner validates every original range after descriptor rights, including uncopied suffixes.
      if (pointer + length <= this.#memory.buffer.byteLength) this.add(pointer, copied, direction);
      remaining -= copied;
    }
  }

  snapshot(): KernelMemoryRegion[] {
    const buffer = this.#memory.buffer;
    return this.#mergedRanges().map(({ start, end, direction }) => ({
      pointer: start,
      direction,
      ...(direction === "out" ? { length: end - start } : {}),
      bytes:
        direction === "out"
          ? new Uint8Array(0)
          : new Uint8Array(buffer, start, end - start).slice(),
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
        !allowed.some(
          (range) => range.direction !== "in" && pointer >= range.start && end <= range.end,
        )
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
      if (
        previous === undefined ||
        range.start > previous.end ||
        (range.start === previous.end && range.direction !== previous.direction)
      ) {
        merged.push({ ...range });
      } else {
        // Aliased inputs and outputs need one shared backing store with the original input bytes.
        merged[merged.length - 1] = {
          start: previous.start,
          end: Math.max(previous.end, range.end),
          direction: previous.direction === range.direction ? range.direction : "inout",
        };
      }
    }
    return merged;
  }
}
