import * as Schema from "effect/Schema";

// Shared with the release range reader, so one RPC never carries a whole engine.
export const ASSET_CHUNK_BYTES = 8 * 1024 * 1024;
export const WORKER_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const WORKER_ASSET_MAX_FILES = { free: 20_000, paid: 100_000 } as const;

const Bytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Chunk = Schema.Struct({ offset: Bytes, length: Bytes, path: Schema.String, sha256: Sha256 });
export const ChunkedAsset = Schema.Struct({
  bytes: Bytes,
  sha256: Sha256,
  chunks: Schema.Array(Chunk),
});
export type ChunkedAsset = typeof ChunkedAsset.Type;

const decode = Schema.decodeUnknownSync(ChunkedAsset, {
  onExcessProperty: "error",
  reportInput: false,
});

export function assertAssetPath(path: string) {
  if (
    !path ||
    /[\\?#]/u.test(path) ||
    path
      .split("")
      .some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("CHUNKED_ASSET_PATH_INVALID");
  return path;
}

export function decodeChunkedAsset(input: unknown): ChunkedAsset {
  const file = decode(structuredClone(input));
  let next = 0;
  for (const chunk of file.chunks) {
    assertAssetPath(chunk.path);
    const length = Math.min(ASSET_CHUNK_BYTES, file.bytes - next);
    if (chunk.offset !== next || length <= 0 || chunk.length !== length)
      throw new Error("CHUNKED_ASSET_COVERAGE_INVALID");
    next += chunk.length;
  }
  if (next !== file.bytes) throw new Error("CHUNKED_ASSET_COVERAGE_INVALID");
  return file;
}

export async function assetSha256(bytes: Uint8Array) {
  const data =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAssetBytes(
  bytes: Uint8Array,
  pin: { readonly bytes: number; readonly sha256: string },
) {
  if (bytes.byteLength !== pin.bytes || (await assetSha256(bytes)) !== pin.sha256)
    throw new Error("CHUNKED_ASSET_PIN_MISMATCH");
}

/** Promoted from the Codex fixture asset pack: fixed offsets and content-addressed chunks. */
export async function writeChunkedAsset(
  bytes: Uint8Array,
  outputPath: string,
  put: (path: string, bytes: Uint8Array, sha256: string) => Promise<void>,
): Promise<ChunkedAsset> {
  assertAssetPath(outputPath);
  const sha256 = await assetSha256(bytes);
  const chunks: Array<typeof Chunk.Type> = [];
  for (let offset = 0; offset < bytes.byteLength; offset += ASSET_CHUNK_BYTES) {
    const length = Math.min(ASSET_CHUNK_BYTES, bytes.byteLength - offset);
    const chunkBytes = bytes.subarray(offset, offset + length);
    const chunkHash = await assetSha256(chunkBytes);
    const path = bytes.byteLength <= ASSET_CHUNK_BYTES ? outputPath : `chunks/${chunkHash}.bin`;
    await put(path, chunkBytes, chunkHash);
    chunks.push({ offset, length, sha256: chunkHash, path });
  }
  return { bytes: bytes.byteLength, sha256, chunks };
}

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export async function readPinnedAsset(
  binding: AssetFetcher,
  pin: { readonly path: string; readonly bytes: number; readonly sha256: string },
) {
  assertAssetPath(pin.path);
  // A literal percent sign in a stored filename must survive URL decoding once.
  const path = pin.path.split("/").map(encodeURIComponent).join("/");
  const response = await binding.fetch(new Request(`https://assets.invalid/${path}`));
  if (!response.ok) throw new Error(`CHUNKED_ASSET_HTTP_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyAssetBytes(bytes, pin);
  return bytes;
}

export async function readChunkedAssetRange(
  binding: AssetFetcher,
  input: ChunkedAsset,
  offset: number,
  length: number,
) {
  const file = decodeChunkedAsset(input);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    length > ASSET_CHUNK_BYTES ||
    offset > file.bytes - length
  )
    throw new Error("CHUNKED_ASSET_RANGE_INVALID");
  const output = new Uint8Array(length);
  for (const chunk of file.chunks) {
    const first = Math.max(offset, chunk.offset);
    const end = Math.min(offset + length, chunk.offset + chunk.length);
    if (end <= first) continue;
    const bytes = await readPinnedAsset(binding, { ...chunk, bytes: chunk.length });
    output.set(bytes.subarray(first - chunk.offset, end - chunk.offset), first - offset);
  }
  return output;
}

export async function readChunkedAsset(binding: AssetFetcher, input: ChunkedAsset) {
  const file = decodeChunkedAsset(input);
  const output = new Uint8Array(file.bytes);
  for (const chunk of file.chunks) {
    const bytes = await readPinnedAsset(binding, { ...chunk, bytes: chunk.length });
    output.set(bytes, chunk.offset);
  }
  await verifyAssetBytes(output, file);
  return output;
}
