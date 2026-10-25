/**
 * Reads an OTLP/JSON export body within fixed bounds, gzip or plain. The
 * compressed and the decompressed size are both capped while streaming, so a
 * small gzip bomb never inflates past the limit in memory.
 */

export const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

/** Why a body was refused, as the status the receiver answers with. */
export class BodyRefused {
  readonly status: 400 | 413 | 415;

  constructor(status: 400 | 413 | 415) {
    this.status = status;
  }
}

export type BodyEncoding = "identity" | "gzip";

export const encodingOf = (header: string | null): BodyEncoding | BodyRefused => {
  const value = (header ?? "").trim().toLowerCase();
  if (value === "" || value === "identity") return "identity";
  if (value === "gzip") return "gzip";
  return new BodyRefused(415);
};

/** The body as text: empty when there is none. */
export const readBody = async (
  request: Request,
  encoding: BodyEncoding,
): Promise<string | BodyRefused> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_COMPRESSED_BYTES) {
    return new BodyRefused(413);
  }
  if (request.body === null) return "";
  const raw = await readBounded(request.body, MAX_COMPRESSED_BYTES);
  if (raw instanceof BodyRefused) return raw;
  if (raw.byteLength === 0) return "";
  const bytes =
    encoding === "gzip"
      ? await readBounded(
          new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip")),
          MAX_DECOMPRESSED_BYTES,
        )
      : raw;
  if (bytes instanceof BodyRefused) return bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new BodyRefused(400);
  }
};

/** A stream's bytes, or 413 past `limit`, or 400 when it fails (a broken gzip, a dropped upload). */
const readBounded = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | BodyRefused> => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return new BodyRefused(413);
      }
      chunks.push(value);
    }
  } catch {
    return new BodyRefused(400);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
