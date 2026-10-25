export function fixture(recordSize = 52) {
  const prefix = 128;
  const table = 64;
  const byteCount = table + recordSize + 1;
  const bytes = new Uint8Array(prefix + byteCount + 48 + 8);
  const graph = bytes.subarray(prefix);
  const data = new DataView(graph.buffer, graph.byteOffset, graph.byteLength);
  graph.set(new TextEncoder().encode("/$bunfs/root/cli"));
  graph.set(new TextEncoder().encode("export default 1;"), 32);
  data.setUint32(table, 0, true);
  data.setUint32(table + 4, 16, true);
  data.setUint32(table + 8, 32, true);
  data.setUint32(table + 12, 17, true);
  graph.set([1, 1, 1, 0], table + recordSize - 4);
  data.setBigUint64(byteCount, BigInt(byteCount), true);
  data.setUint32(byteCount + 8, table, true);
  data.setUint32(byteCount + 12, recordSize, true);
  data.setUint32(byteCount + 20, byteCount - 1, true);
  graph.set(new TextEncoder().encode("\n---- Bun! ----\n"), byteCount + 32);
  data.setBigUint64(byteCount + 48, BigInt(bytes.length), true);
  return {
    bytes,
    graph,
    data,
    table,
    byteCount,
    reader: {
      size: bytes.length,
      async read(offset: number, length: number) {
        return bytes.subarray(offset, offset + length);
      },
    },
  };
}
