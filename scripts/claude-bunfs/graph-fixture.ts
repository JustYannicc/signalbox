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

export function linkedBytecodeFixture() {
  const prefix = 128;
  const table = 128;
  const recordSize = 52;
  const moduleCount = 2;
  const payloadOffset = 96;
  const payload = new TextEncoder().encode("abcdefghijkl");
  const tableLength = recordSize * moduleCount;
  const extensionOffset = table + tableLength;
  const argvOffset = extensionOffset + 32;
  const byteCount = argvOffset + 1;
  const graphLength = byteCount + 32 + 16;
  const bytes = new Uint8Array(prefix + graphLength + 8);
  const graph = bytes.subarray(prefix, prefix + graphLength);
  const data = new DataView(graph.buffer, graph.byteOffset, graph.byteLength);
  const names = ["/$bunfs/root/cli", "/$bunfs/root/dep"];
  const sources = ["export default 1;", "export const dep = 1;"];
  let sourceOffset = 32;

  for (let index = 0; index < moduleCount; index++) {
    const at = table + index * recordSize;
    const nameOffset = index * 16;
    const name = new TextEncoder().encode(names[index]!);
    const source = new TextEncoder().encode(sources[index]!);
    graph.set(name, nameOffset);
    graph.set(source, sourceOffset);
    data.setUint32(at, nameOffset, true);
    data.setUint32(at + 4, name.length, true);
    data.setUint32(at + 8, sourceOffset, true);
    data.setUint32(at + 12, source.length, true);
    data.setUint32(at + 24, payloadOffset + index * 4, true);
    data.setUint32(at + 28, payload.length - index * 4, true);
    graph.set([0, 1, 1, 0], at + recordSize - 4);
    sourceOffset += source.length;
  }
  graph.set(payload, payloadOffset);
  data.setUint32(extensionOffset, payloadOffset, true);
  data.setUint32(extensionOffset + 4, payload.length, true);
  for (let index = 0; index < 6; index++)
    data.setUint32(extensionOffset + 8 + index * 4, ((index + 1) * payload.length) / 6, true);
  graph[argvOffset] = 0;
  data.setBigUint64(byteCount, BigInt(byteCount), true);
  data.setUint32(byteCount + 8, table, true);
  data.setUint32(byteCount + 12, tableLength, true);
  data.setUint32(byteCount + 16, 0, true);
  data.setUint32(byteCount + 20, argvOffset, true);
  data.setUint32(byteCount + 24, 0, true);
  data.setUint32(byteCount + 28, 1 << 13, true);
  graph.set(new TextEncoder().encode("\n---- Bun! ----\n"), byteCount + 32);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    bytes.length - 8,
    BigInt(bytes.length),
    true,
  );

  return {
    bytes,
    payload,
    reader: {
      size: bytes.length,
      async read(offset: number, length: number) {
        return bytes.subarray(offset, offset + length);
      },
    },
  };
}
