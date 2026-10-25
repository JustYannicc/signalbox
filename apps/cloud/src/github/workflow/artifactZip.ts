export const MAX_ARTIFACT_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_ENTRY_BYTES = 8 * 1024 * 1024;

interface EntryMetadata {
  readonly method: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly dataStart: number;
}

type EntryLookup =
  | { readonly _tag: "missing" }
  | { readonly _tag: "found"; readonly metadata: EntryMetadata }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "invalid" };

const centralEntry = 0x02014b50;
const localEntry = 0x04034b50;
const endOfDirectory = 0x06054b50;

const entryMetadata = (
  archive: Uint8Array,
  view: DataView,
  at: number,
  archiveEnd: number,
): EntryMetadata | null => {
  if (at + 46 > archiveEnd || view.getUint32(at, true) !== centralEntry) return null;
  const flags = view.getUint16(at + 8, true);
  const method = view.getUint16(at + 10, true);
  const compressedBytes = view.getUint32(at + 20, true);
  const uncompressedBytes = view.getUint32(at + 24, true);
  const nameBytes = view.getUint16(at + 28, true);
  const extraBytes = view.getUint16(at + 30, true);
  const commentBytes = view.getUint16(at + 32, true);
  const localHeader = view.getUint32(at + 42, true);
  if (
    (flags & 1) !== 0 ||
    (method !== 0 && method !== 8) ||
    compressedBytes === 0xffff_ffff ||
    uncompressedBytes === 0xffff_ffff ||
    localHeader === 0xffff_ffff ||
    at + 46 + nameBytes + extraBytes + commentBytes > archiveEnd ||
    localHeader + 30 > archive.length ||
    view.getUint32(localHeader, true) !== localEntry
  )
    return null;

  const localFlags = view.getUint16(localHeader + 6, true);
  const localMethod = view.getUint16(localHeader + 8, true);
  const localNameBytes = view.getUint16(localHeader + 26, true);
  const localExtraBytes = view.getUint16(localHeader + 28, true);
  const dataStart = localHeader + 30 + localNameBytes + localExtraBytes;
  if (
    localFlags !== flags ||
    localMethod !== method ||
    dataStart > archive.length ||
    compressedBytes > archive.length - dataStart
  )
    return null;
  return { method, compressedBytes, uncompressedBytes, dataStart };
};

const lookupEntry = (archive: Uint8Array, name: string): EntryLookup => {
  if (archive.byteLength < 22) return { _tag: "invalid" };
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const searchStart = Math.max(0, archive.length - 22 - 0xffff);
  let end = -1;
  for (let at = archive.length - 22; at >= searchStart; at--) {
    if (view.getUint32(at, true) === endOfDirectory) {
      end = at;
      break;
    }
  }
  if (end < 0 || end + 22 > archive.length) return { _tag: "invalid" };
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const diskEntries = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  const directoryBytes = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  const commentBytes = view.getUint16(end + 20, true);
  const directoryEnd = directoryStart + directoryBytes;
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    directoryBytes === 0xffff_ffff ||
    directoryStart === 0xffff_ffff ||
    end + 22 + commentBytes !== archive.length ||
    directoryEnd > end
  )
    return { _tag: "invalid" };

  let at = directoryStart;
  let match: EntryMetadata | null = null;
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index++) {
    const metadata = entryMetadata(archive, view, at, directoryEnd);
    if (metadata === null) return { _tag: "invalid" };
    const nameBytes = view.getUint16(at + 28, true);
    const extraBytes = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const entryName = decoder.decode(archive.subarray(at + 46, at + 46 + nameBytes));
    if (entryName === name) {
      if (match !== null) return { _tag: "ambiguous" };
      match = metadata;
    }
    at += 46 + nameBytes + extraBytes + commentLength;
  }
  if (at !== directoryEnd) return { _tag: "invalid" };
  return match === null ? { _tag: "missing" } : { _tag: "found", metadata: match };
};

export const extractArtifactEntry = async (
  archive: Uint8Array,
  name: string,
): Promise<Uint8Array | null> => {
  const lookup = lookupEntry(archive, name);
  if (lookup._tag === "missing") return null;
  if (lookup._tag !== "found") throw new Error("Artifact ZIP entry is " + lookup._tag + ".");
  if (
    lookup.metadata.uncompressedBytes > MAX_ARTIFACT_ENTRY_BYTES ||
    lookup.metadata.compressedBytes > MAX_ARTIFACT_ARCHIVE_BYTES
  )
    throw new Error("Artifact ZIP entry exceeds the size limit.");
  const { method, compressedBytes, uncompressedBytes, dataStart } = lookup.metadata;
  const compressed = archive.subarray(dataStart, dataStart + compressedBytes);
  if (method === 0) {
    if (compressedBytes !== uncompressedBytes)
      throw new Error("Artifact ZIP entry size does not match its directory.");
    return compressed.slice();
  }

  const output = new Uint8Array(uncompressedBytes);
  const reader = new Blob([compressed.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > output.byteLength - bytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Artifact ZIP entry size does not match its directory.");
      }
      output.set(value, bytes);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes !== output.byteLength)
    throw new Error("Artifact ZIP entry size does not match its directory.");
  return output;
};

export const isSafeEntryPath = (entryPath: string) =>
  entryPath.length > 0 &&
  entryPath.length <= 1_024 &&
  !entryPath.startsWith("/") &&
  !entryPath.includes("\\") &&
  !entryPath.includes("\0") &&
  entryPath.split("/").every((part) => part !== "" && part !== "." && part !== "..");
