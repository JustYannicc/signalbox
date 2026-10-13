import {
  hex,
  inflate,
  objectId,
  type ObjectType,
  type Oid,
  referencedOids,
  sha1,
} from "./gitObjects.ts";
import type { Bytes } from "./gitObjects.ts";

/**
 * Git packfiles and their v2 indexes: reading one object at a byte range, and
 * checking a whole uploaded pack before a drive accepts it. Packs a drive
 * stores are never thin: every delta's base is in the same pack, so any object
 * can be read from its own pack alone.
 */

const TYPE_CODES: Readonly<Record<number, ObjectType | "ofs_delta" | "ref_delta">> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs_delta",
  7: "ref_delta",
};

export class PackError extends Error {}

export interface PackIndexEntry {
  readonly oid: Oid;
  readonly offset: number;
}

export interface PackIndex {
  readonly entries: ReadonlyArray<PackIndexEntry>;
  /** The pack's own trailing checksum, as hex. */
  readonly packChecksum: string;
}

const u32 = (bytes: Bytes, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/** Reads a version 2 `.idx`. */
async function parsePackIndex(idx: Bytes): Promise<PackIndex> {
  if (idx.length < 8 + 1024 + 40 || u32(idx, 0) !== 0xff744f63 || u32(idx, 4) !== 2) {
    throw new PackError("Not a version 2 pack index.");
  }
  const count = u32(idx, 8 + 255 * 4);
  const oids = 8 + 1024;
  const offsets = oids + count * 20 + count * 4;
  const large = offsets + count * 4;
  if (idx.length < large + 40) throw new PackError("Truncated pack index.");
  const trailer = idx.length - 40;
  if ((await sha1(idx.subarray(0, trailer + 20))) !== hex(idx.subarray(trailer + 20))) {
    throw new PackError("Pack index checksum mismatch.");
  }
  const entries: Array<PackIndexEntry> = [];
  for (let i = 0; i < count; i++) {
    const raw = u32(idx, offsets + i * 4);
    let offset = raw;
    if (raw & 0x80000000) {
      const at = large + (raw & 0x7fffffff) * 8;
      offset = u32(idx, at) * 2 ** 32 + u32(idx, at + 4);
    }
    entries.push({ oid: hex(idx.subarray(oids + i * 20, oids + i * 20 + 20)), offset });
  }
  return { entries, packChecksum: hex(idx.subarray(trailer, trailer + 20)) };
}

/** One object's header in a pack, read from the bytes at its offset. */
export interface EntryHeader {
  readonly kind: ObjectType | "ofs_delta" | "ref_delta";
  /** Inflated size (of the delta, for deltas). */
  readonly size: number;
  /** Bytes the header itself takes, including a delta's base reference. */
  readonly headerLength: number;
  /** An `ofs_delta`'s base, as a distance back from this object. */
  readonly baseDistance?: number;
  readonly baseOid?: Oid;
}

export function readEntryHeader(bytes: Bytes, at = 0): EntryHeader {
  let byte = bytes[at]!;
  const kind = TYPE_CODES[(byte >> 4) & 7];
  if (kind === undefined) throw new PackError("Unknown pack object type.");
  let size = byte & 15;
  let shift = 4;
  let pos = at + 1;
  while (byte & 0x80) {
    byte = bytes[pos++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (kind === "ofs_delta") {
    byte = bytes[pos++]!;
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      byte = bytes[pos++]!;
      distance = (distance + 1) * 128 + (byte & 0x7f);
    }
    return { kind, size, headerLength: pos - at, baseDistance: distance };
  }
  if (kind === "ref_delta") {
    return {
      kind,
      size,
      headerLength: pos - at + 20,
      baseOid: hex(bytes.subarray(pos, pos + 20)),
    };
  }
  return { kind, size, headerLength: pos - at };
}

/** Applies a git delta to `base`. */
export function applyDelta(base: Bytes, delta: Bytes): Bytes {
  let at = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = delta[at++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new PackError("Delta base size mismatch.");
  const out = new Uint8Array(varint());
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[at++]! * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) length += delta[at++]! * 2 ** (8 * i);
      if (length === 0) length = 0x10000;
      if (offset + length > base.length || written + length > out.length) {
        throw new PackError("Delta copies out of range.");
      }
      out.set(base.subarray(offset, offset + length), written);
      written += length;
    } else if (op !== 0) {
      if (written + op > out.length || at + op > delta.length) {
        throw new PackError("Delta inserts out of range.");
      }
      out.set(delta.subarray(at, at + op), written);
      written += op;
      at += op;
    } else {
      throw new PackError("Reserved delta opcode.");
    }
  }
  if (written !== out.length) throw new PackError("Delta result size mismatch.");
  return out;
}

/** What a drive records about each object of a pack it accepts. */
export interface PackedObject {
  readonly oid: Oid;
  readonly type: ObjectType;
  readonly offset: number;
  /** Bytes from `offset` to the next object: header plus compressed data. */
  readonly length: number;
  /** Inflated size of the object itself. */
  readonly size: number;
}

export interface VerifiedPack {
  readonly name: string;
  readonly objects: ReadonlyArray<PackedObject>;
  /** Commits and trees, inflated: a drive indexes commits and checks references. */
  readonly structure: ReadonlyMap<
    Oid,
    { readonly type: "commit" | "tree"; readonly content: Bytes }
  >;
  /** Objects this pack's commits and trees point at that it does not contain. */
  readonly external: ReadonlySet<Oid>;
}

/**
 * Checks an uploaded pack against its index: both checksums, every object's
 * id recomputed from its content, every delta's base inside the pack. Returns
 * what the pack holds and which objects outside it its commits and trees
 * reference, which the drive must already have. Anything else is refused.
 */
export async function verifyPack(pack: Bytes, idxBytes: Bytes): Promise<VerifiedPack> {
  if (pack.length < 32 || u32(pack, 0) !== 0x5041434b) throw new PackError("Not a pack.");
  const version = u32(pack, 4);
  if (version !== 2 && version !== 3) throw new PackError("Unsupported pack version.");
  const end = pack.length - 20;
  const checksum = hex(pack.subarray(end));
  if ((await sha1(pack.subarray(0, end))) !== checksum) {
    throw new PackError("Pack checksum mismatch.");
  }
  const idx = await parsePackIndex(idxBytes);
  if (idx.packChecksum !== checksum) throw new PackError("Index is for another pack.");
  if (idx.entries.length !== u32(pack, 8)) throw new PackError("Index and pack disagree.");

  const byOffset = [...idx.entries].sort((a, b) => a.offset - b.offset);
  const spans = new Map<number, { readonly oid: Oid; readonly length: number }>();
  byOffset.forEach((entry, i) => {
    const next = byOffset[i + 1]?.offset ?? end;
    if (entry.offset < 12 || next > end || next <= entry.offset) {
      throw new PackError("Index offsets are out of range.");
    }
    spans.set(entry.offset, { oid: entry.oid, length: next - entry.offset });
  });
  const offsetOf = new Map(idx.entries.map((entry) => [entry.oid, entry.offset]));

  // Only delta bases need to stay inflated while the rest is read.
  const headers = new Map(
    byOffset.map((entry) => [entry.offset, readEntryHeader(pack, entry.offset)]),
  );
  const baseOffsetOf = (offset: number, header: EntryHeader) => {
    const base =
      header.kind === "ofs_delta"
        ? offset - header.baseDistance!
        : header.kind === "ref_delta"
          ? offsetOf.get(header.baseOid!)
          : undefined;
    if (base === undefined || !spans.has(base)) {
      throw new PackError("A delta's base is not in the pack.");
    }
    return base;
  };
  const neededBases = new Set<number>();
  for (const [offset, header] of headers) {
    if (header.kind === "ofs_delta" || header.kind === "ref_delta") {
      neededBases.add(baseOffsetOf(offset, header));
    }
  }

  const resolved = new Map<number, { readonly type: ObjectType; readonly content: Bytes }>();
  const resolving = new Set<number>();
  const resolve = async (
    offset: number,
  ): Promise<{ readonly type: ObjectType; readonly content: Bytes }> => {
    const cached = resolved.get(offset);
    if (cached !== undefined) return cached;
    if (resolving.has(offset)) throw new PackError("Delta cycle.");
    resolving.add(offset);
    const header = headers.get(offset)!;
    const span = spans.get(offset)!;
    const data = await inflate(pack.subarray(offset + header.headerLength, offset + span.length));
    if (data.length !== header.size) throw new PackError("Object size mismatch.");
    let object;
    if (header.kind === "ofs_delta" || header.kind === "ref_delta") {
      const base = await resolve(baseOffsetOf(offset, header));
      object = { type: base.type, content: applyDelta(base.content, data) };
    } else {
      object = { type: header.kind, content: data };
    }
    resolving.delete(offset);
    if (neededBases.has(offset)) resolved.set(offset, object);
    return object;
  };

  const objects: Array<PackedObject> = [];
  const structure = new Map<Oid, { readonly type: "commit" | "tree"; readonly content: Bytes }>();
  const referenced = new Set<Oid>();
  for (const { offset } of byOffset) {
    const span = spans.get(offset)!;
    const object = await resolve(offset);
    if ((await objectId(object.type, object.content)) !== span.oid) {
      throw new PackError(`Object ${span.oid} does not match its content.`);
    }
    objects.push({
      oid: span.oid,
      type: object.type,
      offset,
      length: span.length,
      size: object.content.length,
    });
    if (object.type === "commit" || object.type === "tree") {
      structure.set(span.oid, { type: object.type, content: object.content });
      for (const oid of referencedOids(object.type, object.content)) referenced.add(oid);
    }
  }
  const external = new Set([...referenced].filter((oid) => !offsetOf.has(oid)));
  return { name: checksum, objects, structure, external };
}
