import { WasiError, WasiMemory } from "../wasi/internal_wasi_memory.ts";
import type { KernelMemoryRegion } from "../KernelSyscallPort.ts";

/** Only syscall arguments cross the RPC boundary. The child retains its complete linear memory. */
export class SyscallMemory extends WasiMemory {
  #size = 0;
  #regions: KernelMemoryRegion[] = [];

  bind(size: number, regions: readonly KernelMemoryRegion[]) {
    if (!Number.isSafeInteger(size) || size < 0 || size > 0x1_0000_0000) {
      throw new TypeError("Invalid guest memory size");
    }
    let previousEnd = 0;
    this.#regions = regions.map((region) => {
      if (
        !Number.isSafeInteger(region.pointer) ||
        region.pointer < previousEnd ||
        !(region.bytes instanceof Uint8Array) ||
        region.pointer + region.bytes.byteLength > size
      ) {
        throw new TypeError("Invalid syscall memory regions");
      }
      previousEnd = region.pointer + region.bytes.byteLength;
      return { pointer: region.pointer, bytes: region.bytes.slice() };
    });
    this.#size = size;
  }

  override range(pointer: number, length: number): Uint8Array<ArrayBuffer> {
    const start = pointer >>> 0;
    const size = length >>> 0;
    if (start + size > this.#size) throw new WasiError(21);
    if (size === 0) return new Uint8Array(0);
    const region = this.#regions.find(
      (candidate) =>
        start >= candidate.pointer && start + size <= candidate.pointer + candidate.bytes.length,
    );
    if (!region) throw new Error("Syscall memory region was not supplied");
    // bind() copied each region, so every view has an owned ArrayBuffer.
    return new Uint8Array(
      region.bytes.buffer as ArrayBuffer,
      region.bytes.byteOffset + start - region.pointer,
      size,
    );
  }

  snapshot(): readonly KernelMemoryRegion[] {
    return this.#regions.map((region) => ({
      pointer: region.pointer,
      bytes: region.bytes.slice(),
    }));
  }

  clear() {
    this.#regions = [];
    this.#size = 0;
  }
}
