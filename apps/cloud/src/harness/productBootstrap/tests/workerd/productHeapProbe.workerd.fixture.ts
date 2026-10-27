const MAX_HEAP_PROBE_BYTES = 12 * 1024 * 1024;

/** Retains known backing bytes on one DO instance to identify its CDP isolate. */
export class ProductHeapProbe {
  #buffer: ArrayBuffer | undefined;

  hold(bytes: number) {
    if (
      this.#buffer !== undefined ||
      !Number.isSafeInteger(bytes) ||
      bytes !== MAX_HEAP_PROBE_BYTES
    )
      throw new RangeError("The Worker heap probe must be idle and exactly 12 MiB.");
    const buffer = new ArrayBuffer(bytes);
    const view = new Uint8Array(buffer);
    for (let offset = 0; offset < bytes; offset += 4096) view[offset] = 0x5a;
    this.#buffer = buffer;
    return { heldBytes: buffer.byteLength } as const;
  }

  release() {
    const releasedBytes = this.#buffer?.byteLength ?? 0;
    this.#buffer = undefined;
    return { releasedBytes } as const;
  }
}
