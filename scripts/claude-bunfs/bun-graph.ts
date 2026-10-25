// Layout derived from DigiBugCat/codex-wasi-agentos (Apache-2.0),
// scripts/claude-bunfs/bunfs_list.py at 45eca7daf24bbac603689cc3229693310d184e51.
import { locateBunGraph, type BinaryReader } from "./bun-container.ts";

export const regionNames = [
  "name",
  "contents",
  "sourcemap",
  "bytecode",
  "moduleInfo",
  "bytecodeOriginPath",
] as const;
export type Region = { offset: number; length: number };
export type BunModule = {
  index: number;
  name: string;
  key: string;
  encoding: number;
  loader: number;
  format: number;
  side: number;
  regions: Record<string, Region>;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`BUN_FORMAT_CHANGED: ${message}`);
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function readBunGraph(reader: BinaryReader) {
  const location = await locateBunGraph(reader);
  const footerSize = location.offsetsSize;
  const trailerSize = 16;
  invariant(location.length >= footerSize + trailerSize, "graph shorter than its footer");
  const footer = view(
    await reader.read(location.offset + location.length - footerSize - trailerSize, footerSize),
  );
  const byteCount = Number(footer.getBigUint64(0, true));
  invariant(
    byteCount === location.length - footerSize - trailerSize,
    "byte_count disagrees with graph length",
  );
  const table = { offset: footer.getUint32(8, true), length: footer.getUint32(12, true) };
  const entry = footer.getUint32(16, true);
  const argv =
    footerSize === 32
      ? { offset: footer.getUint32(20, true), length: footer.getUint32(24, true) }
      : undefined;
  const flags = footerSize === 32 ? footer.getUint32(28, true) : undefined;
  if (flags !== undefined) {
    invariant((flags & ~0x3fff) === 0, `unknown graph flags 0x${flags.toString(16)}`);
  }
  const checked = (region: Region) => {
    invariant(
      region.offset <= byteCount && region.length <= byteCount - region.offset,
      "region outside graph",
    );
    return region;
  };
  checked(table);
  if (argv) checked(argv);
  invariant(table.length > 0 && table.length <= 16 * 1024 * 1024, "invalid module table size");
  const records = await reader.read(location.offset + table.offset, table.length);
  const candidates: { recordSize: number; modules: BunModule[] }[] = [];
  for (const recordSize of [52, 36]) {
    if (table.length % recordSize !== 0 || entry >= table.length / recordSize) continue;
    try {
      const modules: BunModule[] = [];
      const names = new Set<string>();
      const pointers = (recordSize - 4) / 8;
      const data = view(records);
      for (let index = 0; index < table.length / recordSize; index++) {
        const at = index * recordSize;
        const regions: Record<string, Region> = {};
        for (let p = 0; p < pointers; p++) {
          regions[regionNames[p]!] = checked({
            offset: data.getUint32(at + p * 8, true),
            length: data.getUint32(at + p * 8 + 4, true),
          });
        }
        const tail = at + recordSize - 4;
        const encoding = data.getUint8(tail);
        const loader = data.getUint8(tail + 1);
        const format = data.getUint8(tail + 2);
        const side = data.getUint8(tail + 3);
        invariant(
          encoding <= 2 && loader <= 21 && format <= 2 && side <= 1,
          "unknown module discriminant",
        );
        const nameRegion = regions.name!;
        invariant(
          nameRegion.length > 0 && nameRegion.length <= 16384,
          "invalid module name length",
        );
        const name = new TextDecoder("utf-8", { fatal: true }).decode(
          await reader.read(location.offset + nameRegion.offset, nameRegion.length),
        );
        invariant(!name.includes("\0") && !names.has(name), "empty, NUL or duplicate module name");
        names.add(name);
        const contents = regions.contents!;
        invariant(
          encoding !== 2 || (contents.length % 2 === 0 && contents.offset % 2 === 0),
          "unaligned UTF-16 contents",
        );
        modules.push({
          index,
          name,
          key: name.replace(/^\/+/, ""),
          encoding,
          loader,
          format,
          side,
          regions,
        });
      }
      candidates.push({ recordSize, modules });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  invariant(
    candidates.length === 1,
    `expected one known module layout, found ${candidates.length}`,
  );
  const candidate = candidates[0]!;
  if (footerSize === 24) {
    invariant(
      table.offset + table.length === byteCount,
      "unrecognized data after legacy module table",
    );
  }
  // Flagged extension records follow the module table, before the compile argv.
  if (flags !== undefined && argv) {
    let cursor = table.offset + table.length;
    const word = async () => {
      invariant(cursor + 4 <= argv.offset, "truncated graph extension");
      const result = view(await reader.read(location.offset + cursor, 4)).getUint32(0, true);
      cursor += 4;
      return result;
    };
    const pointer = async () => checked({ offset: await word(), length: await word() });
    const count = candidate.modules.length;
    if (flags & 32) cursor += count * 4;
    if (flags & 64) {
      const builtins = await word();
      invariant(builtins <= 65536, "invalid builtin count");
      for (let i = 0; i < builtins; i++) {
        await word();
        await pointer();
      }
    }
    if (flags & 128) await pointer();
    if (flags & 256) invariant((await word()) <= count, "invalid startup count");
    if (flags & 512) await pointer();
    if (flags & 2048) {
      await pointer();
      const prelinked = await word();
      invariant(prelinked <= count, "invalid prelinked count");
      for (let i = 0; i < prelinked; i++)
        invariant((await word()) < count, "invalid prelinked module");
    }
    if (flags & 4096) {
      await word();
      await word();
    }
    if (flags & 8192) {
      const payload = await pointer();
      let previous = 0;
      // Bun's LINKED_BYTECODE_REGION_COUNT is six at source pin 25ef6936.
      for (let i = 0; i < 6; i++) {
        const end = await word();
        invariant(end >= previous && end <= payload.length, "invalid linked bytecode region");
        previous = end;
      }
      invariant(previous === payload.length, "incomplete linked bytecode payload");
    }
    invariant(cursor === argv.offset, "unrecognized data after module table");
    invariant(argv.offset + argv.length + 1 === byteCount, "unexpected data after compile argv");
    invariant(
      (await reader.read(location.offset + byteCount - 1, 1))[0] === 0,
      "compile argv lacks terminator",
    );
  }
  return {
    ...location,
    byteCount,
    flags,
    entry,
    recordSize: candidate.recordSize,
    modules: candidate.modules,
  };
}

export function decodeModule(bytes: Uint8Array, encoding: number) {
  if (encoding === 2) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (encoding === 1) {
    // WHATWG's latin1 decoder is Windows-1252; Bun stores actual Latin-1 code units.
    let result = "";
    for (let at = 0; at < bytes.length; at += 8192)
      result += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return result;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
