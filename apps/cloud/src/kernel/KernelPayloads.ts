const ownedBuffers = new WeakSet<ArrayBufferLike>();
const PIPE_RETAINED_BYTES = 16 * 1024 * 1024;
let pipeBytes = 0;

/** Arrived syscall inputs can be lent to a blocked descriptor without another copy. */
export function ownKernelPayload<Buffer extends ArrayBufferLike>(bytes: Uint8Array<Buffer>) {
  ownedBuffers.add(bytes.buffer);
  return bytes;
}

export function isKernelPayloadOwned(bytes: Uint8Array) {
  return ownedBuffers.has(bytes.buffer);
}

export function retainKernelPipePayload(source: Uint8Array, maximum: number) {
  const bytes = Math.min(source.byteLength, maximum, PIPE_RETAINED_BYTES - pipeBytes);
  pipeBytes += bytes;
  let released = false;
  return {
    bytes,
    release() {
      if (released) return;
      released = true;
      pipeBytes -= bytes;
    },
  };
}
