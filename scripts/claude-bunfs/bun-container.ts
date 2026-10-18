export type BinaryReader = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
};

export type BunGraphLocation = {
  container: "elf" | "macho" | "pe" | "legacy";
  offset: number;
  length: number;
  offsetsSize: 24 | 32;
};

const GRAPH_TRAILER = new Uint8Array([
  0x0a, 0x2d, 0x2d, 0x2d, 0x2d, 0x20, 0x42, 0x75, 0x6e, 0x21, 0x20, 0x2d, 0x2d, 0x2d, 0x2d, 0x0a,
]);
const OFFSETS_SIZES = [24, 32] as const;
const ELF_HEADER_SIZE = 64;
const ELF_SECTION_HEADER_SIZE = 64;
const MACH_HEADER_SIZE = 32;
const MACH_SEGMENT_SIZE = 72;
const MACH_SECTION_SIZE = 80;
const PE_SECTION_SIZE = 40;

function invalid(container: string, message: string): never {
  throw new Error(`BUN_FORMAT_CHANGED: ${container}: ${message}`);
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalid(label, "offset overflow");
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) invalid(label, "size overflow");
  return result;
}

function ensureRange(offset: number, length: number, limit: number, label: string): number {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > limit ||
    length > limit - offset
  ) {
    invalid(label, `range ${offset}+${length} is outside ${limit} bytes`);
  }
  return offset + length;
}

async function readExact(
  reader: BinaryReader,
  offset: number,
  length: number,
  label: string,
): Promise<Uint8Array> {
  ensureRange(offset, length, reader.size, label);
  const bytes = await reader.read(offset, length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    invalid(label, `reader returned ${bytes?.byteLength ?? "no"} bytes for a ${length}-byte read`);
  }
  return bytes;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(bytes: Uint8Array, offset: number, label: string): number {
  ensureRange(offset, 2, bytes.byteLength, label);
  return view(bytes).getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number, label: string): number {
  ensureRange(offset, 4, bytes.byteLength, label);
  return view(bytes).getUint32(offset, true);
}

function u64(bytes: Uint8Array, offset: number, label: string): number {
  ensureRange(offset, 8, bytes.byteLength, label);
  const value = view(bytes).getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(label, "value exceeds safe file offsets");
  return Number(value);
}

function bytesEqualAt(bytes: Uint8Array, offset: number, width: number, expected: string): boolean {
  if (expected.length > width || offset < 0 || offset + width > bytes.byteLength) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
  }
  for (let i = expected.length; i < width; i++) {
    if (bytes[offset + i] !== 0) return false;
  }
  return true;
}

function nulTerminatedEquals(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset >= bytes.byteLength) return false;
  let end = offset;
  while (end < bytes.byteLength && bytes[end] !== 0) end++;
  if (end === bytes.byteLength || end - offset !== expected.length) return false;
  return bytesEqualAt(bytes, offset, expected.length, expected);
}

async function validateGraph(
  reader: BinaryReader,
  offset: number,
  length: number,
  container: BunGraphLocation["container"],
): Promise<BunGraphLocation> {
  if (length < OFFSETS_SIZES[0] + GRAPH_TRAILER.length) {
    invalid(container, "module graph is too short");
  }
  ensureRange(offset, length, reader.size, `${container} module graph`);

  const trailer = await readExact(
    reader,
    offset + length - GRAPH_TRAILER.length,
    GRAPH_TRAILER.length,
    `${container} trailer`,
  );
  if (!bytesEqualAt(trailer, 0, trailer.byteLength, "\n---- Bun! ----\n")) {
    invalid(container, "module graph trailer is missing or malformed");
  }

  const matches: BunGraphLocation[] = [];
  const failures: string[] = [];
  for (const offsetsSize of OFFSETS_SIZES) {
    const suffixSize = offsetsSize + GRAPH_TRAILER.length;
    if (length < suffixSize) continue;
    try {
      const offsetsAt = offset + length - suffixSize;
      const byteCountBytes = await readExact(reader, offsetsAt, 8, `${container} offsets`);
      const byteCount = u64(byteCountBytes, 0, `${container} offsets`);
      if (byteCount === length - suffixSize) {
        matches.push({ container, offset, length, offsetsSize });
      } else {
        failures.push(`${offsetsSize}-byte Offsets byte_count disagrees with graph length`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) invalid(container, "module graph Offsets schema is ambiguous");
  invalid(container, `no supported Offsets schema matches (${failures.join("; ")})`);
}

async function readLengthPrefixedGraph(
  reader: BinaryReader,
  dataOffset: number,
  sectionSize: number,
  container: "elf" | "macho" | "pe",
  prefixSizes: readonly (4 | 8)[] = [8],
): Promise<BunGraphLocation> {
  ensureRange(dataOffset, sectionSize, reader.size, `${container} .bun section`);
  const matches: BunGraphLocation[] = [];
  const failures: string[] = [];
  for (const prefixSize of prefixSizes) {
    try {
      if (sectionSize < prefixSize) invalid(container, "section is shorter than its length prefix");
      const label = `${container} ${prefixSize}-byte .bun length`;
      const lengthBytes = await readExact(reader, dataOffset, prefixSize, label);
      const length = prefixSize === 4 ? u32(lengthBytes, 0, label) : u64(lengthBytes, 0, label);
      if (length > sectionSize - prefixSize) {
        invalid(
          container,
          `declared module graph exceeds the .bun section with a ${prefixSize}-byte prefix`,
        );
      }
      matches.push(await validateGraph(reader, dataOffset + prefixSize, length, container));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    invalid(container, "multiple length prefixes describe valid module graphs");
  invalid(
    container,
    `no supported length prefix matches a valid module graph (${failures.join("; ")})`,
  );
}

type ElfSection = { type: number; offset: number; size: number };

async function locateElfSection(reader: BinaryReader): Promise<BunGraphLocation | undefined> {
  const header = await readExact(reader, 0, ELF_HEADER_SIZE, "ELF header");
  if (header[4] !== 2) invalid("ELF", "only 64-bit ELF files are supported");
  if (header[5] !== 1) invalid("ELF", "only little-endian ELF files are supported");
  if (header[6] !== 1 || u32(header, 20, "ELF header") !== 1) {
    invalid("ELF", "unsupported ELF version");
  }
  if (u16(header, 52, "ELF header") < ELF_HEADER_SIZE) invalid("ELF", "header is truncated");

  const sectionTableOffset = u64(header, 40, "ELF section table");
  const entrySize = u16(header, 58, "ELF section table");
  const encodedCount = u16(header, 60, "ELF section table");
  const encodedStringIndex = u16(header, 62, "ELF section names");
  if (sectionTableOffset === 0 && encodedCount === 0) return undefined;
  if (sectionTableOffset === 0 || entrySize < ELF_SECTION_HEADER_SIZE) {
    invalid("ELF", "malformed section table header");
  }

  let sectionCount = encodedCount;
  let stringIndex = encodedStringIndex;
  if (sectionCount === 0 || stringIndex === 0xffff) {
    const sectionZero = await readExact(
      reader,
      sectionTableOffset,
      ELF_SECTION_HEADER_SIZE,
      "ELF section zero",
    );
    if (sectionCount === 0) sectionCount = u64(sectionZero, 32, "ELF extended section count");
    if (stringIndex === 0xffff)
      stringIndex = u32(sectionZero, 40, "ELF extended string table index");
  }
  if (sectionCount === 0) invalid("ELF", "section table has no section zero");

  const tableSize = checkedMultiply(sectionCount, entrySize, "ELF section table");
  ensureRange(sectionTableOffset, tableSize, reader.size, "ELF section table");
  const sections = await readExact(reader, sectionTableOffset, tableSize, "ELF section table");
  if (stringIndex === 0) return undefined;
  if (stringIndex >= sectionCount)
    invalid("ELF", "section-name string table index is out of range");

  const stringHeaderAt = stringIndex * entrySize;
  if (u32(sections, stringHeaderAt + 4, "ELF section-name table") !== 3) {
    invalid("ELF", "section-name table is not a string table");
  }
  const stringOffset = u64(sections, stringHeaderAt + 24, "ELF section-name table");
  const stringSize = u64(sections, stringHeaderAt + 32, "ELF section-name table");
  ensureRange(stringOffset, stringSize, reader.size, "ELF section-name table");
  const strings = await readExact(reader, stringOffset, stringSize, "ELF section-name table");
  if (strings.byteLength === 0 || strings[0] !== 0) {
    invalid("ELF", "malformed section-name string table");
  }

  let bunSection: ElfSection | undefined;
  for (let i = 0; i < sectionCount; i++) {
    const at = i * entrySize;
    const nameOffset = u32(sections, at, "ELF section header");
    if (nameOffset >= strings.byteLength) invalid("ELF", "section name offset is out of range");
    let nameEnd = nameOffset;
    while (nameEnd < strings.byteLength && strings[nameEnd] !== 0) nameEnd++;
    if (nameEnd === strings.byteLength) invalid("ELF", "section name is not NUL-terminated");
    if (!nulTerminatedEquals(strings, nameOffset, ".bun")) continue;
    if (bunSection) invalid("ELF", "multiple .bun sections are ambiguous");
    bunSection = {
      type: u32(sections, at + 4, "ELF .bun section"),
      offset: u64(sections, at + 24, "ELF .bun section"),
      size: u64(sections, at + 32, "ELF .bun section"),
    };
  }
  if (!bunSection) return undefined;
  if (bunSection.type === 8) invalid("ELF", ".bun section has no file contents");
  return readLengthPrefixedGraph(reader, bunSection.offset, bunSection.size, "elf");
}

async function locateMachOSection(reader: BinaryReader): Promise<BunGraphLocation | undefined> {
  const header = await readExact(reader, 0, MACH_HEADER_SIZE, "Mach-O header");
  const commandCount = u32(header, 16, "Mach-O header");
  const commandBytes = u32(header, 20, "Mach-O header");
  const commandsStart = MACH_HEADER_SIZE;
  const commandsEnd = ensureRange(commandsStart, commandBytes, reader.size, "Mach-O load commands");

  let cursor = commandsStart;
  let bunSection: { offset: number; size: number } | undefined;
  for (let i = 0; i < commandCount; i++) {
    const commandHeader = await readExact(reader, cursor, 8, "Mach-O load command");
    const command = u32(commandHeader, 0, "Mach-O load command");
    const commandSize = u32(commandHeader, 4, "Mach-O load command");
    if (commandSize < 8) invalid("Mach-O", "load command has an invalid size");
    ensureRange(cursor, commandSize, commandsEnd, "Mach-O load command");

    if (command === 0x19) {
      if (commandSize < MACH_SEGMENT_SIZE) invalid("Mach-O", "LC_SEGMENT_64 is truncated");
      const segment = await readExact(reader, cursor, MACH_SEGMENT_SIZE, "Mach-O segment");
      const isBunSegment = bytesEqualAt(segment, 8, 16, "__BUN");
      const sectionCount = u32(segment, 64, "Mach-O segment");
      const sectionBytes = checkedMultiply(sectionCount, MACH_SECTION_SIZE, "Mach-O section table");
      const sectionTableSize = checkedAdd(MACH_SEGMENT_SIZE, sectionBytes, "Mach-O section table");
      if (sectionTableSize > commandSize) invalid("Mach-O", "section table exceeds LC_SEGMENT_64");
      if (isBunSegment && sectionCount > 0) {
        const sections = await readExact(
          reader,
          cursor + MACH_SEGMENT_SIZE,
          sectionBytes,
          "Mach-O section table",
        );
        for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
          const at = sectionIndex * MACH_SECTION_SIZE;
          const isBunName = bytesEqualAt(sections, at, 16, "__bun");
          if (!isBunName) continue;
          if (!bytesEqualAt(sections, at + 16, 16, "__BUN")) {
            invalid("Mach-O", "__bun section names a different segment");
          }
          if (bunSection) invalid("Mach-O", "multiple __BUN,__bun sections are ambiguous");
          if ((u32(sections, at + 64, "Mach-O __bun section") & 0xff) !== 0) {
            invalid("Mach-O", "__bun section is not file-backed data");
          }
          bunSection = {
            size: u64(sections, at + 40, "Mach-O __bun section"),
            offset: u32(sections, at + 48, "Mach-O __bun section"),
          };
        }
      }
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd) invalid("Mach-O", "load-command sizes do not match sizeofcmds");
  if (!bunSection) return undefined;
  return readLengthPrefixedGraph(reader, bunSection.offset, bunSection.size, "macho", [8, 4]);
}

async function locatePESection(reader: BinaryReader): Promise<BunGraphLocation | undefined> {
  const dosHeader = await readExact(reader, 0, 64, "PE DOS header");
  const peOffset = u32(dosHeader, 0x3c, "PE DOS header");
  if (peOffset < 64) invalid("PE", "header offset overlaps the DOS header");
  const signature = await readExact(reader, peOffset, 24, "PE header");
  if (!bytesEqualAt(signature, 0, 4, "PE\0\0")) invalid("PE", "signature is malformed");
  const sectionCount = u16(signature, 6, "PE COFF header");
  const optionalHeaderSize = u16(signature, 20, "PE COFF header");
  if (optionalHeaderSize < 2) invalid("PE", "optional header is missing");
  const optionalHeaderOffset = peOffset + 24;
  ensureRange(optionalHeaderOffset, optionalHeaderSize, reader.size, "PE optional header");
  const optionalHeader = await readExact(
    reader,
    optionalHeaderOffset,
    optionalHeaderSize,
    "PE optional header",
  );
  if (u16(optionalHeader, 0, "PE optional header") !== 0x20b) {
    invalid("PE", "only PE32+ files with 64-bit Bun graphs are supported");
  }

  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sectionTableSize = checkedMultiply(sectionCount, PE_SECTION_SIZE, "PE section table");
  ensureRange(sectionTableOffset, sectionTableSize, reader.size, "PE section table");
  const sections = await readExact(
    reader,
    sectionTableOffset,
    sectionTableSize,
    "PE section table",
  );
  let bunSection: { rawOffset: number; rawSize: number; virtualSize: number } | undefined;
  for (let i = 0; i < sectionCount; i++) {
    const at = i * PE_SECTION_SIZE;
    if (!bytesEqualAt(sections, at, 8, ".bun")) continue;
    if (bunSection) invalid("PE", "multiple .bun sections are ambiguous");
    bunSection = {
      virtualSize: u32(sections, at + 8, "PE .bun section"),
      rawSize: u32(sections, at + 16, "PE .bun section"),
      rawOffset: u32(sections, at + 20, "PE .bun section"),
    };
  }
  if (!bunSection) return undefined;
  ensureRange(bunSection.rawOffset, bunSection.rawSize, reader.size, "PE .bun raw data");
  if (bunSection.virtualSize === 0) invalid("PE", ".bun section has no virtual contents");
  return readLengthPrefixedGraph(
    reader,
    bunSection.rawOffset,
    Math.min(bunSection.rawSize, bunSection.virtualSize),
    "pe",
    [8, 4],
  );
}

async function locateLegacyGraph(reader: BinaryReader): Promise<BunGraphLocation | undefined> {
  if (reader.size < 8 + OFFSETS_SIZES[0] + GRAPH_TRAILER.length) return undefined;
  const footerOffset = reader.size - 8;
  const [totalSizeBytes, trailer] = await Promise.all([
    readExact(reader, footerOffset, 8, "legacy EOF length"),
    readExact(reader, footerOffset - GRAPH_TRAILER.length, GRAPH_TRAILER.length, "legacy trailer"),
  ]);
  if (view(totalSizeBytes).getBigUint64(0, true) !== BigInt(reader.size)) return undefined;
  if (!bytesEqualAt(trailer, 0, trailer.byteLength, "\n---- Bun! ----\n")) return undefined;

  const candidates: BunGraphLocation[] = [];
  const failures: string[] = [];
  for (const offsetsSize of OFFSETS_SIZES) {
    const offsetsAt = footerOffset - GRAPH_TRAILER.length - offsetsSize;
    try {
      const byteCountBytes = await readExact(reader, offsetsAt, 8, "legacy offsets");
      const byteCount = u64(byteCountBytes, 0, "legacy offsets");
      if (byteCount > offsetsAt) {
        failures.push(`${offsetsSize}-byte Offsets places the graph before the file start`);
        continue;
      }
      const offset = offsetsAt - byteCount;
      const length = checkedAdd(byteCount, offsetsSize + GRAPH_TRAILER.length, "legacy graph");
      const location = await validateGraph(reader, offset, length, "legacy");
      if (location.offsetsSize === offsetsSize) candidates.push(location);
      else
        failures.push(
          `${offsetsSize}-byte candidate resolves as ${location.offsetsSize}-byte Offsets`,
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("module graph Offsets schema is ambiguous")
      ) {
        invalid("legacy", "EOF footer matches multiple Offsets schemas");
      }
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) invalid("legacy", "EOF footer matches multiple Offsets schemas");
  invalid("legacy", `EOF footer has no supported Offsets schema (${failures.join("; ")})`);
}

/** Locates Bun's serialized module graph without loading the executable into memory. */
export async function locateBunGraph(reader: BinaryReader): Promise<BunGraphLocation> {
  if (!Number.isSafeInteger(reader.size) || reader.size < 0) {
    invalid("binary", "BinaryReader.size must be a non-negative safe integer");
  }

  let sectionGraph: BunGraphLocation | undefined;
  if (reader.size >= 4) {
    const magic = await readExact(reader, 0, 4, "executable magic");
    if (magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46) {
      sectionGraph = await locateElfSection(reader);
    } else if (magic[0] === 0xcf && magic[1] === 0xfa && magic[2] === 0xed && magic[3] === 0xfe) {
      sectionGraph = await locateMachOSection(reader);
    } else if (magic[0] === 0x4d && magic[1] === 0x5a) {
      sectionGraph = await locatePESection(reader);
    }
  }
  if (sectionGraph) return sectionGraph;

  const legacyGraph = await locateLegacyGraph(reader);
  if (legacyGraph) return legacyGraph;
  invalid("binary", "unsupported executable or Bun graph footer is missing");
}
