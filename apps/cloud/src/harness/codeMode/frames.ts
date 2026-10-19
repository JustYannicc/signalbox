import type { Json } from "./types.ts";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeCodeModeFrame(message: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  if (payload.length > MAX_FRAME_BYTES) throw new Error("CodeMode frame exceeds 64 MiB");
  const frame = new Uint8Array(payload.length + 4);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);
  return frame;
}

/** Exact reads avoid allocating the advertised payload until its bounded header is complete. */
export async function* readCodeModeFrames(input: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = input.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let cursor = 0;
  const exact = async (target: Uint8Array, allowEof = false) => {
    let offset = 0;
    while (offset < target.length) {
      if (cursor === chunk.length) {
        const next = await reader.read();
        if (next.done) {
          if (offset === 0 && allowEof) return false;
          throw new Error("Truncated CodeMode frame");
        }
        chunk = next.value;
        cursor = 0;
      }
      const count = Math.min(target.length - offset, chunk.length - cursor);
      target.set(chunk.subarray(cursor, cursor + count), offset);
      offset += count;
      cursor += count;
    }
    return true;
  };
  try {
    const header = new Uint8Array(4);
    while (await exact(header, true)) {
      const length = new DataView(header.buffer).getUint32(0, true);
      if (length > MAX_FRAME_BYTES) throw new Error("CodeMode frame exceeds 64 MiB");
      const payload = new Uint8Array(length);
      await exact(payload);
      yield JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
