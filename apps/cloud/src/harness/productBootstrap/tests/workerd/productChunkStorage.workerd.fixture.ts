import { HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES } from "../../../HarnessProcessPlacement.ts";

export const PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES = 64 * 1024;
export const PRODUCT_FIXTURE_R18_SEED_CHUNK_BYTES = 1024 * 1024;

type Storage = DurableObjectStorage;
type AssetInfo = { readonly bytes: number; readonly sha256: string };
type InputInfo = { readonly totalBytes: number; readonly sha256: string };

const releaseInfoKey = (artifactRef: string, path: string) =>
  `fixture/release-info/${artifactRef}/${encodeURIComponent(path)}`;
const releaseChunkKey = (artifactRef: string, path: string, offset: number) =>
  `fixture/release/${artifactRef}/${encodeURIComponent(path)}/${offset}`;
const inputInfoKey = (path: string) => `proof-input/r18/info/${encodeURIComponent(path)}`;
const inputChunkKey = (path: string, offset: number) =>
  `proof-input/r18/chunk/${encodeURIComponent(path)}/${offset}`;

export async function storeProductFixtureReleaseAsset(
  storage: Storage,
  artifactRef: string,
  path: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<void> {
  await storage.put(releaseInfoKey(artifactRef, path), {
    bytes: bytes.byteLength,
    sha256,
  } satisfies AssetInfo);
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES
  ) {
    const entries: Record<string, string> = Object.create(null);
    const rangeEnd = Math.min(bytes.byteLength, offset + HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES);
    for (
      let chunkOffset = offset;
      chunkOffset < rangeEnd;
      chunkOffset += PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES
    )
      entries[releaseChunkKey(artifactRef, path, chunkOffset)] = bytesToBase64(
        bytes.subarray(
          chunkOffset,
          Math.min(bytes.byteLength, chunkOffset + PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES),
        ),
      );
    try {
      await storage.put(entries);
    } catch (cause) {
      throw new Error(`Could not store fixture release chunks for ${path} at ${offset}.`, {
        cause,
      });
    }
  }
}

export async function readProductFixtureReleaseRange(
  storage: Storage,
  artifactRef: string,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const info = await storage.get<AssetInfo>(releaseInfoKey(artifactRef, path));
  if (
    info === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES ||
    offset + length > info.bytes
  )
    throw new RangeError("The requested release asset range is invalid.");
  return readStoredRange(
    storage,
    (chunkOffset) => releaseChunkKey(artifactRef, path, chunkOffset),
    offset,
    length,
  );
}

export async function readProductFixtureReleaseAsset(
  storage: Storage,
  artifactRef: string,
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> {
  const info = await storage.get<AssetInfo>(releaseInfoKey(artifactRef, path));
  if (info === undefined) throw new Error(`Fixture artifact does not contain ${path}.`);
  const bytes = new Uint8Array(info.bytes);
  for (let offset = 0; offset < info.bytes; offset += HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES) {
    const chunk = await readProductFixtureReleaseRange(
      storage,
      artifactRef,
      path,
      offset,
      Math.min(HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES, info.bytes - offset),
    );
    bytes.set(chunk, offset);
  }
  return { bytes, sha256: info.sha256 };
}

export async function seedProductFixtureR18Range(
  storage: Storage,
  path: string,
  offset: number,
  totalBytes: number,
  sha256: string,
  bytes: Uint8Array,
): Promise<number> {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % PRODUCT_FIXTURE_R18_SEED_CHUNK_BYTES !== 0 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sha256)
  )
    throw new RangeError("The R18 fixture range metadata is invalid.");
  const expectedLength = Math.min(PRODUCT_FIXTURE_R18_SEED_CHUNK_BYTES, totalBytes - offset);
  if (expectedLength <= 0 || bytes.byteLength !== expectedLength)
    throw new RangeError("The R18 fixture range has the wrong byte length.");

  const key = inputInfoKey(path);
  const info = await storage.get<InputInfo>(key);
  if (info !== undefined && (info.totalBytes !== totalBytes || info.sha256 !== sha256))
    throw new Error("The R18 fixture file metadata changed between ranges.");
  if (info === undefined) await storage.put(key, { totalBytes, sha256 } satisfies InputInfo);

  const entries: Record<string, string> = Object.create(null);
  const offsets: number[] = [];
  for (
    let chunkOffset = offset;
    chunkOffset < offset + bytes.byteLength;
    chunkOffset += PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES
  ) {
    const relativeOffset = chunkOffset - offset;
    const chunk = bytes.subarray(
      relativeOffset,
      Math.min(bytes.byteLength, relativeOffset + PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES),
    );
    entries[inputChunkKey(path, chunkOffset)] = bytesToBase64(chunk);
    offsets.push(chunkOffset);
  }

  const keys = offsets.map((chunkOffset) => inputChunkKey(path, chunkOffset));
  const existing = await storage.get<string>(keys);
  for (const chunkOffset of offsets) {
    const chunkKey = inputChunkKey(path, chunkOffset);
    const encoded = existing.get(chunkKey);
    if (encoded === undefined) continue;
    const current = base64ToBytes(encoded);
    const relativeOffset = chunkOffset - offset;
    const proposed = bytes.subarray(relativeOffset, relativeOffset + current.byteLength);
    if (
      current.byteLength !== proposed.byteLength ||
      current.some((byte, index) => byte !== proposed[index])
    )
      throw new Error("The R18 fixture range changed after it was staged.");
    delete entries[chunkKey];
  }
  if (Object.keys(entries).length > 0) await storage.put(entries);
  return bytes.byteLength;
}

export async function readProductFixtureR18Range(
  storage: Storage,
  path: string,
  offset: number,
): Promise<{ readonly totalBytes: number; readonly sha256: string; readonly bytes: Uint8Array }> {
  const info = await storage.get<InputInfo>(inputInfoKey(path));
  if (
    info === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES !== 0 ||
    offset >= info.totalBytes
  )
    throw new RangeError("The requested R18 fixture range is unavailable.");
  const length = Math.min(HARNESS_PROCESS_RELEASE_ASSET_CHUNK_BYTES, info.totalBytes - offset);
  return {
    ...info,
    bytes: await readStoredRange(
      storage,
      (chunkOffset) => inputChunkKey(path, chunkOffset),
      offset,
      length,
    ),
  };
}

export async function hasProductFixtureR18Range(storage: Storage, path: string): Promise<boolean> {
  return (await storage.get<InputInfo>(inputInfoKey(path))) !== undefined;
}

async function readStoredRange(
  storage: Storage,
  keyForOffset: (offset: number) => string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const offsets: number[] = [];
  for (
    let chunkOffset =
      Math.floor(offset / PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES) *
      PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES;
    chunkOffset < offset + length;
    chunkOffset += PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES
  )
    offsets.push(chunkOffset);
  const keys = offsets.map(keyForOffset);
  const values = await storage.get<string>(keys);
  const output = new Uint8Array(length);
  for (let readOffset = 0; readOffset < length;) {
    const absoluteOffset = offset + readOffset;
    const chunkOffset =
      Math.floor(absoluteOffset / PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES) *
      PRODUCT_FIXTURE_STORAGE_CHUNK_BYTES;
    const key = keyForOffset(chunkOffset);
    const encoded = values.get(key);
    if (encoded === undefined) throw new Error(`Fixture chunk is missing at ${chunkOffset}.`);
    const bytes = base64ToBytes(encoded);
    const withinChunk = absoluteOffset - chunkOffset;
    const count = Math.min(length - readOffset, bytes.byteLength - withinChunk);
    if (count <= 0) throw new Error(`Fixture chunk is malformed at ${chunkOffset}.`);
    output.set(bytes.subarray(withinChunk, withinChunk + count), readOffset);
    readOffset += count;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16 * 1024));
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1)
    bytes[offset] = binary.charCodeAt(offset);
  return bytes;
}
