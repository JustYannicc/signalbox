import { describe, expect, it } from "vite-plus/test";
import { decodeModule, readBunGraph } from "./bun-graph.ts";

import { fixture } from "./graph-fixture.ts";

function legacy24Fixture(recordSize = 36, unexplainedBytes = 0) {
  const current = fixture(recordSize);
  const prefix = current.bytes.length - current.byteCount - 48 - 8;
  const byteCount = current.byteCount - 1 + unexplainedBytes;
  const footerOffset = prefix + byteCount;
  const bytes = new Uint8Array(prefix + byteCount + 24 + 16 + 8);
  bytes.set(current.bytes.subarray(0, footerOffset));
  const data = new DataView(bytes.buffer);
  data.setBigUint64(footerOffset, BigInt(byteCount), true);
  data.setUint32(footerOffset + 8, current.table, true);
  data.setUint32(footerOffset + 12, recordSize, true);
  data.setUint32(footerOffset + 16, 0, true);
  bytes.set(new TextEncoder().encode("\n---- Bun! ----\n"), footerOffset + 24);
  data.setBigUint64(bytes.length - 8, BigInt(bytes.length), true);
  return {
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
      expect(parsed.offsetsSize).toBe(32);
      expect(parsed.recordSize).toBe(recordSize);
      expect(parsed.modules[parsed.entry]).toMatchObject({
        name: "/$bunfs/root/cli",
        key: "$bunfs/root/cli",
        encoding: 1,
        loader: 1,
        format: 1,
        regions: { contents: { offset: 32, length: 17 } },
      });
    },
  );
  it("reads the Bun 1.2.0 24-byte footer and 36-byte records without argv or flags", async () => {
    const f = legacy24Fixture();
    const parsed = await readBunGraph(f.reader);

    expect(parsed).toMatchObject({
      offsetsSize: 24,
      byteCount: f.byteCount,
      entry: 0,
      recordSize: 36,
    });
    expect(parsed.flags).toBeUndefined();
    expect(parsed.modules[parsed.entry]).toMatchObject({
      name: "/$bunfs/root/cli",
      key: "$bunfs/root/cli",
      regions: { contents: { offset: 32, length: 17 } },
    });
  });
  it("rejects unknown flags even when existing records parse", async () => {
    const f = fixture();
    f.data.setUint32(f.byteCount + 28, 1 << 20, true);
    await expect(readBunGraph(f.reader)).rejects.toThrow("unknown graph flags");
  });
  it("rejects unexplained trailing data in the 24-byte format", async () => {
    await expect(readBunGraph(legacy24Fixture(36, 4).reader)).rejects.toThrow(
      "unrecognized data after legacy module table",
    );
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
