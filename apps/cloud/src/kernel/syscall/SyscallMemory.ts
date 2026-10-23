import * as NodeBuffer from "node:buffer";
import { WasiMemory } from "../wasi/internal_wasi_memory.ts";
import type { KernelMemoryRegion } from "../KernelSyscallPort.ts";

interface BoundRegion {
  readonly pointer: number;
  readonly length: number;
  readonly direction: NonNullable<KernelMemoryRegion["direction"]>;
  readonly original: Uint8Array;
  bytes: Uint8Array<ArrayBuffer> | undefined;
  readonly writes: Array<{ start: number; end: number }>;
}

/** Only syscall arguments cross the RPC boundary. The child retains its complete linear memory. */
export class SyscallMemory extends WasiMemory {
  #size = 0;
  #regions: BoundRegion[] = [];

  override get byteLength(): number {
    return this.#size;
  }

  bind(size: number, regions: readonly KernelMemoryRegion[]) {
    if (!Number.isSafeInteger(size) || size < 0 || size > 0x1_0000_0000) {
      throw new TypeError("Invalid guest memory size");
    }
    let previousEnd = 0;
    this.#regions = regions.map((region) => {
      const direction = region.direction ?? "inout";
      if (!(region.bytes instanceof Uint8Array))
        throw new TypeError("Invalid syscall memory regions");
      const length = direction === "out" ? region.length : region.bytes.byteLength;
      if (
        !Number.isSafeInteger(region.pointer) ||
        region.pointer < previousEnd ||
        length === undefined ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        region.pointer + length > size ||
        !["in", "out", "inout"].includes(direction) ||
        (direction === "out" ? region.bytes.byteLength !== 0 : region.length !== undefined)
      ) {
        throw new TypeError("Invalid syscall memory regions");
      }
      previousEnd = region.pointer + length;
      return {
        pointer: region.pointer,
        length,
        direction,
        original: region.bytes,
        bytes: direction === "out" ? undefined : region.bytes.slice(),
        writes: [],
      };
    });
    this.#size = size;
  }

  override range(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    const start = pointer >>> 0;
    const size = length >>> 0;
    this.validateRange(start, size);
    if (size === 0) return new Uint8Array(0);
    const region = this.#region(start, size);
    const bytes = (region.bytes ??= new Uint8Array(region.length));
    return new Uint8Array(bytes.buffer, bytes.byteOffset + start - region.pointer, size);
  }

  override writeRange(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    const bytes = this.range(pointer, length);
    if (bytes.length === 0) return bytes;
    const region = this.#region(pointer >>> 0, bytes.length);
    if (region.direction === "in") throw new Error("Syscall wrote to input-only memory");
    if (region.direction === "out") {
      const start = (pointer >>> 0) - region.pointer;
      region.writes.push({ start, end: start + bytes.length });
    }
    return bytes;
  }

  snapshot(): readonly KernelMemoryRegion[] {
    return this.#regions.flatMap((region) => {
      const bytes = region.bytes;
      if (region.direction === "in" || bytes === undefined) return [];
      if (region.direction === "out") {
        const merged: Array<{ start: number; end: number }> = [];
        for (const range of region.writes.sort((a, b) => a.start - b.start)) {
          const previous = merged.at(-1);
          if (previous && range.start <= previous.end)
            previous.end = Math.max(previous.end, range.end);
          else merged.push({ ...range });
        }
        return merged.map(({ start, end }) => ({
          pointer: region.pointer + start,
          bytes: bytes.slice(start, end),
        }));
      }
      // Native comparison skips scalar scans of unchanged legacy or aliased in-out buffers.
      if (NodeBuffer.Buffer.compare(bytes, region.original) === 0) return [];
      let first = 0;
      while (first < bytes.length && bytes[first] === region.original[first]) first++;
      let last = bytes.length;
      while (last > first && bytes[last - 1] === region.original[last - 1]) last--;
      const start = Math.floor(first / 8) * 8;
      const end = Math.min(bytes.length, Math.ceil(last / 8) * 8);
      return [{ pointer: region.pointer + start, bytes: bytes.slice(start, end) }];
    });
  }

  clear() {
    this.#regions = [];
    this.#size = 0;
  }

  #region(start: number, size: number): BoundRegion {
    const region = this.#regions.find(
      (candidate) =>
        start >= candidate.pointer && start + size <= candidate.pointer + candidate.length,
    );
    if (!region) throw new Error("Syscall memory region was not supplied");
    return region;
  }
}
