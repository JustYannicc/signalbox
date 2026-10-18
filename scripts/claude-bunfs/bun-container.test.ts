import { describe, expect, it } from "vite-plus/test";
import { locateBunGraph, type BinaryReader } from "./bun-container.js";

const trailer = new TextEncoder().encode("\n---- Bun! ----\n");

function put16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function put32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function put64(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setBigUint64(offset, BigInt(value), true);
}

function makeGraph(bodyLength = 17): Uint8Array {
  const graph = new Uint8Array(bodyLength + 32 + trailer.length);
  graph.fill(0x41, 0, bodyLength);
  put64(graph, bodyLength, bodyLength);
  graph.set(trailer, bodyLength + 32);
  return graph;
}

function makeElf(
  graph: Uint8Array,
  duplicateBun = false,
): { bytes: Uint8Array; graphOffset: number } {
  const strings = new TextEncoder().encode("\0.shstrtab\0.bun\0");
  const sectionCount = duplicateBun ? 4 : 3;
  const sectionTableOffset = 64;
  const stringsOffset = sectionTableOffset + sectionCount * 64;
  const bunSectionOffset = stringsOffset + strings.length;
  const sectionSpan = 8 + graph.length;
  const bytes = new Uint8Array(bunSectionOffset + sectionSpan);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  put32(bytes, 20, 1);
  put64(bytes, 40, sectionTableOffset);
  put16(bytes, 52, 64);
  put16(bytes, 58, 64);
  put16(bytes, 60, sectionCount);
  put16(bytes, 62, 1);

  const stringHeader = sectionTableOffset + 64;
  put32(bytes, stringHeader, 1);
  put32(bytes, stringHeader + 4, 3);
  put64(bytes, stringHeader + 24, stringsOffset);
  put64(bytes, stringHeader + 32, strings.length);
  bytes.set(strings, stringsOffset);

  const bunHeader = sectionTableOffset + 128;
  put32(bytes, bunHeader, 11);
  put32(bytes, bunHeader + 4, 1);
  put64(bytes, bunHeader + 24, bunSectionOffset);
  put64(bytes, bunHeader + 32, sectionSpan);
  if (duplicateBun) {
    const duplicateHeader = sectionTableOffset + 192;
    put32(bytes, duplicateHeader, 11);
    put32(bytes, duplicateHeader + 4, 1);
    put64(bytes, duplicateHeader + 24, bunSectionOffset);
    put64(bytes, duplicateHeader + 32, sectionSpan);
  }
  put64(bytes, bunSectionOffset, graph.length);
  bytes.set(graph, bunSectionOffset + 8);
  return { bytes, graphOffset: bunSectionOffset + 8 };
}

function makeMachO(
  graph: Uint8Array,
  duplicateBun = false,
  prefixSize: 4 | 8 = 8,
): { bytes: Uint8Array; graphOffset: number } {
  const sectionCount = duplicateBun ? 2 : 1;
  const commandSize = 72 + sectionCount * 80;
  const sectionDataOffset = 32 + commandSize;
  const sectionSpan = prefixSize + graph.length;
  const bytes = new Uint8Array(sectionDataOffset + sectionSpan);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  put32(bytes, 16, 1);
  put32(bytes, 20, commandSize);
  put32(bytes, 32, 0x19);
  put32(bytes, 36, commandSize);
  bytes.set(new TextEncoder().encode("__BUN"), 40);
  put32(bytes, 32 + 64, sectionCount);

  for (let i = 0; i < sectionCount; i++) {
    const at = 32 + 72 + i * 80;
    bytes.set(new TextEncoder().encode("__bun"), at);
    bytes.set(new TextEncoder().encode("__BUN"), at + 16);
    put64(bytes, at + 40, sectionSpan);
    put32(bytes, at + 48, sectionDataOffset);
  }
  if (prefixSize === 4) put32(bytes, sectionDataOffset, graph.length);
  else put64(bytes, sectionDataOffset, graph.length);
  bytes.set(graph, sectionDataOffset + prefixSize);
  return { bytes, graphOffset: sectionDataOffset + prefixSize };
}

function makePE(
  graph: Uint8Array,
  duplicateBun = false,
  prefixSize: 4 | 8 = 8,
): { bytes: Uint8Array; graphOffset: number } {
  const peOffset = 0x80;
  const sectionCount = duplicateBun ? 2 : 1;
  const optionalHeaderSize = 0xf0;
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize;
  const rawOffset = 0x200;
  const sectionSpan = prefixSize + graph.length;
  const rawSize = Math.ceil(sectionSpan / 0x200) * 0x200;
  const bytes = new Uint8Array(rawOffset + rawSize);
  bytes.set([0x4d, 0x5a], 0);
  put32(bytes, 0x3c, peOffset);
  bytes.set([0x50, 0x45, 0, 0], peOffset);
  put16(bytes, peOffset + 4 + 2, sectionCount);
  put16(bytes, peOffset + 4 + 16, optionalHeaderSize);
  put16(bytes, peOffset + 24, 0x20b);

  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTableOffset + i * 40;
    bytes.set([0x2e, 0x62, 0x75, 0x6e], at);
    put32(bytes, at + 8, sectionSpan);
    put32(bytes, at + 16, rawSize);
    put32(bytes, at + 20, rawOffset);
  }
  if (prefixSize === 4) put32(bytes, rawOffset, graph.length);
  else put64(bytes, rawOffset, graph.length);
  bytes.set(graph, rawOffset + prefixSize);
  return { bytes, graphOffset: rawOffset + prefixSize };
}

function makeLegacy(graph: Uint8Array): { bytes: Uint8Array; graphOffset: number } {
  const prefix = new Uint8Array(128).fill(0x7f);
  const bytes = new Uint8Array(prefix.length + graph.length + 8);
  bytes.set(prefix);
  bytes.set(graph, prefix.length);
  put64(bytes, bytes.length - 8, bytes.length);
  return { bytes, graphOffset: prefix.length };
}

function reader(bytes: Uint8Array): BinaryReader {
  return {
    size: bytes.byteLength,
    read: async (offset, length) => bytes.slice(offset, offset + length),
  };
}

describe("locateBunGraph", () => {
  it("locates the graph in an ELF64 little-endian .bun section", async () => {
    const fixture = makeElf(makeGraph());

    await expect(locateBunGraph(reader(fixture.bytes))).resolves.toEqual({
      container: "elf",
      offset: fixture.graphOffset,
      length: makeGraph().length,
    });
  });

  it("locates the __BUN/__bun Mach-O section", async () => {
    const fixture = makeMachO(makeGraph());

    await expect(locateBunGraph(reader(fixture.bytes))).resolves.toEqual({
      container: "macho",
      offset: fixture.graphOffset,
      length: makeGraph().length,
    });
  });

  it("locates the PE32+ .bun section", async () => {
    const fixture = makePE(makeGraph());

    await expect(locateBunGraph(reader(fixture.bytes))).resolves.toEqual({
      container: "pe",
      offset: fixture.graphOffset,
      length: makeGraph().length,
    });
  });

  it("locates historical Mach-O and PE sections with 4-byte length prefixes", async () => {
    const graph = makeGraph();
    const macho = makeMachO(graph, false, 4);
    const pe = makePE(graph, false, 4);

    await expect(locateBunGraph(reader(macho.bytes))).resolves.toEqual({
      container: "macho",
      offset: macho.graphOffset,
      length: graph.length,
    });
    await expect(locateBunGraph(reader(pe.bytes))).resolves.toEqual({
      container: "pe",
      offset: pe.graphOffset,
      length: graph.length,
    });
  });

  it("locates a legacy graph from the EOF total-byte count", async () => {
    const fixture = makeLegacy(makeGraph());

    await expect(locateBunGraph(reader(fixture.bytes))).resolves.toEqual({
      container: "legacy",
      offset: fixture.graphOffset,
      length: makeGraph().length,
    });
  });

  it("rejects duplicate .bun sections", async () => {
    const fixture = makeElf(makeGraph(), true);

    await expect(locateBunGraph(reader(fixture.bytes))).rejects.toThrow(/multiple \.bun sections/);
  });

  it("rejects duplicate Mach-O and PE sections", async () => {
    const macho = makeMachO(makeGraph(), true);
    const pe = makePE(makeGraph(), true);

    await expect(locateBunGraph(reader(macho.bytes))).rejects.toThrow(
      /multiple __BUN,__bun sections/,
    );
    await expect(locateBunGraph(reader(pe.bytes))).rejects.toThrow(/multiple \.bun sections/);
  });

  it("rejects a section whose length prefix runs past its bounds", async () => {
    const fixture = makePE(makeGraph());
    put64(fixture.bytes, fixture.graphOffset - 8, 0x10000);

    await expect(locateBunGraph(reader(fixture.bytes))).rejects.toThrow(
      /exceeds the \.bun section/,
    );
  });

  it("rejects a graph with a missing trailer", async () => {
    const fixture = makeMachO(makeGraph());
    fixture.bytes[fixture.graphOffset + makeGraph().length - 1] = 0;

    await expect(locateBunGraph(reader(fixture.bytes))).rejects.toThrow(/trailer is missing/);
  });

  it("rejects an invalid legacy EOF count and unknown files", async () => {
    const legacy = makeLegacy(makeGraph());
    put64(legacy.bytes, legacy.bytes.length - 8, legacy.bytes.length - 1);
    await expect(locateBunGraph(reader(legacy.bytes))).rejects.toThrow(/unsupported executable/);
    await expect(locateBunGraph(reader(new Uint8Array(64).fill(0x41)))).rejects.toThrow(
      /unsupported executable/,
    );
  });

  it("rejects non-little-endian ELF containers", async () => {
    const fixture = makeElf(makeGraph());
    fixture.bytes[5] = 2;

    await expect(locateBunGraph(reader(fixture.bytes))).rejects.toThrow(/little-endian ELF/);
  });
});
