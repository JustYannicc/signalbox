import { describe, expect, it } from "vite-plus/test";
import { decodeModule, readBunGraph } from "./bun-graph.ts";

function fixture(recordSize = 52) {
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

describe("Bun graph validation", () => {
  it.each([36, 52])(
    "preserves names and source regions for %i-byte records",
    async (recordSize) => {
      const f = fixture(recordSize);
      const parsed = await readBunGraph(f.reader);
      expect(parsed.recordSize).toBe(recordSize);
      expect(parsed.modules[parsed.entry]).toMatchObject({
        name: "/$bunfs/root/cli",
        encoding: 1,
        loader: 1,
        format: 1,
        regions: { contents: { offset: 32, length: 17 } },
      });
    },
  );
  it("rejects unknown flags even when existing records parse", async () => {
    const f = fixture();
    f.data.setUint32(f.byteCount + 28, 1 << 20, true);
    await expect(readBunGraph(f.reader)).rejects.toThrow("unknown graph flags");
  });
  it("rejects contents outside the graph", async () => {
    const f = fixture();
    f.data.setUint32(f.table + 8, f.byteCount - 2, true);
    await expect(readBunGraph(f.reader)).rejects.toThrow("known module layout");
  });
  it("rejects unknown loader values", async () => {
    const f = fixture();
    f.graph[f.table + 49] = 255;
    await expect(readBunGraph(f.reader)).rejects.toThrow("known module layout");
  });
  it("rejects unaligned UTF-16 contents", async () => {
    const f = fixture();
    f.graph[f.table + 48] = 2;
    await expect(readBunGraph(f.reader)).rejects.toThrow("known module layout");
  });
  it("rejects unexplained bytes between records and argv", async () => {
    const f = fixture();
    f.data.setUint32(f.byteCount + 20, f.byteCount, true);
    await expect(readBunGraph(f.reader)).rejects.toThrow("unrecognized data");
  });
  it("decodes Latin-1 without Windows-1252 substitutions and UTF-16 surrogate pairs", () => {
    expect(decodeModule(new Uint8Array([0x80, 0xff]), 1)).toBe("\u0080\u00ff");
    expect(decodeModule(new Uint8Array([0x3d, 0xd8, 0x00, 0xde]), 2)).toBe("😀");
  });
});
