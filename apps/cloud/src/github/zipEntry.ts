/**
 * One file out of a zip archive, as GitHub serves workflow artifacts. Reads
 * the central directory (streamed archives leave sizes out of the local
 * headers) and inflates with the platform's `DecompressionStream`, which
 * workerd and Node both have. Null when the archive has no such file or isn't
 * one this understands (stored or deflated, no zip64, no encryption).
 */
export const zipEntry = async (archive: Uint8Array, name: string): Promise<Uint8Array | null> => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end of central directory record sits in the last 22 bytes plus a comment of up to 64 KiB.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let entry = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (entry + 46 > archive.length || view.getUint32(entry, true) !== 0x02014b50) return null;
    const flags = view.getUint16(entry + 8, true);
    const method = view.getUint16(entry + 10, true);
    const compressedSize = view.getUint32(entry + 20, true);
    const nameLength = view.getUint16(entry + 28, true);
    const extraLength = view.getUint16(entry + 30, true);
    const commentLength = view.getUint16(entry + 32, true);
    const localHeader = view.getUint32(entry + 42, true);
    const entryName = decoder.decode(archive.subarray(entry + 46, entry + 46 + nameLength));
    entry += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if ((flags & 1) !== 0 || localHeader + 30 > archive.length) return null;
    const dataStart =
      localHeader +
      30 +
      view.getUint16(localHeader + 26, true) +
      view.getUint16(localHeader + 28, true);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return data;
    if (method !== 8) return null;
    // A copy: Blob wants bytes on a plain ArrayBuffer.
    const inflated = new Blob([data.slice()])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
  }
  return null;
};
