// @effect-diagnostics nodeBuiltinImport:off - streaming SHA-1: WebCrypto only hashes whole buffers.
import * as NodeCrypto from "node:crypto";

import {
  type Bytes,
  concatBytes,
  hex,
  inflate,
  type ObjectType,
  type Oid,
  parseCommit,
  parseTree,
  referencedOids,
} from "./gitObjects.ts";
import {
  applyDelta,
  deltaSizes,
  type EntryHeader,
  PackError,
  type PackedObject,
  parsePackIndex,
  readEntryHeader,
  u32,
  type VerifiedPack,
} from "./gitPack.ts";

/**
 * `verifyPack` for a pack too big to hold in memory (#406): read once, in
 * order, from a stream, never holding more than one object of up to
 * `MAX_HELD_BYTES` plus the pack's commits and folders.
 *
 * It checks the pack's checksum and that the index is for it, every
 * object's offset, and every object's id except one kind: a file stored as a
 * delta against another file, which only a reader holding the base can check.
 * Such a file is checked when it is read (`DriveReader`). Commits and folders,
 * the only objects a drive interprets, are all checked, deltas included, and a
 * big file is hashed as it inflates, without being held.
 */

/** An object whose compressed bytes take more than this streams through instead of being held. */
const MAX_HELD_BYTES = 16 * 1024 * 1024;
/** Enough bytes for any entry header, a ref delta's base id and a delta's two sizes. */
const HEADER_BYTES = 64;

const encoder = new TextEncoder();

/** Bytes from a stream, taken in order, each hashed into `hash` until `hashUntil`. */
class PackReader {
  private readonly reader: ReadableStreamDefaultReader<Bytes>;
  private readonly hash: NodeCrypto.Hash;
  private readonly hashUntil: number;
  private queue: Array<Bytes> = [];
  private queued = 0;
  position = 0;

  constructor(stream: ReadableStream<Bytes>, hash: NodeCrypto.Hash, hashUntil: number) {
    this.reader = stream.getReader();
    this.hash = hash;
    this.hashUntil = hashUntil;
  }

  private account(bytes: Bytes) {
    const hashed = Math.max(0, Math.min(bytes.length, this.hashUntil - this.position));
    if (hashed > 0) this.hash.update(bytes.subarray(0, hashed));
    this.position += bytes.length;
    return bytes;
  }

  private async fill(n: number) {
    while (this.queued < n) {
      const next = await this.reader.read();
      if (next.done) throw new PackError("The pack ends early.");
      this.queue.push(next.value);
      this.queued += next.value.length;
    }
  }

  /** At most `n` bytes, as they come. */
  private async chunk(n: number): Promise<Bytes> {
    await this.fill(1);
    const first = this.queue[0]!;
    if (first.length <= n) {
      this.queue.shift();
      this.queued -= first.length;
      return this.account(first);
    }
    this.queue[0] = first.subarray(n);
    this.queued -= n;
    return this.account(first.subarray(0, n));
  }

  /** Exactly `n` bytes, held. */
  async take(n: number): Promise<Bytes> {
    const first = await this.chunk(n);
    if (first.length === n) return first;
    const out = new Uint8Array(n);
    out.set(first, 0);
    for (let at = first.length; at < n;) {
      const part = await this.chunk(n - at);
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** Lets the stream go, as when reading stops early. */
  cancel() {
    return this.reader.cancel().catch(() => undefined);
  }

  /** Exactly `n` bytes, chunk by chunk, never all held. */
  async *stream(n: number): AsyncGenerator<Bytes> {
    for (let left = n; left > 0;) {
      const part = await this.chunk(left);
      left -= part.length;
      yield part;
    }
  }

  async end() {
    const next = await this.reader.read();
    if (!next.done || this.queued > 0) throw new PackError("The pack has bytes past its end.");
  }
}

/** An object's id, hashed without copying its content. */
const idOf = (type: ObjectType, content: Uint8Array) =>
  NodeCrypto.createHash("sha1")
    .update(encoder.encode(`${type} ${content.length}\0`))
    .update(content)
    .digest("hex");

/**
 * Inflates `compressed`, given as its first bytes then the rest streamed,
 * feeding the result to `sink`; answers the inflated size.
 */
const inflateStreaming = async (
  first: Bytes,
  rest: AsyncIterable<Bytes>,
  sink: (bytes: Uint8Array) => void,
) => {
  const inflater = new DecompressionStream("deflate");
  const writer = inflater.writable.getWriter();
  const writing = (async () => {
    try {
      await writer.write(first);
      for await (const part of rest) await writer.write(part);
      await writer.close();
    } catch (error) {
      // Ends the reading side too, so neither waits on the other.
      await writer.abort(error).catch(() => undefined);
      throw error;
    }
  })();
  const reading = (async () => {
    let size = 0;
    const reader = inflater.readable.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.length;
      sink(next.value);
    }
    return size;
  })();
  const [size] = await Promise.all([reading, writing]);
  return size;
};

export async function verifyPackStream(input: {
  readonly stream: ReadableStream<Bytes>;
  /** The pack's length in bytes, as stored. */
  readonly size: number;
  readonly idx: Bytes;
}): Promise<VerifiedPack> {
  if (input.size < 32) throw new PackError("Not a pack.");
  const end = input.size - 20;
  const packHash = NodeCrypto.createHash("sha1");
  const pack = new PackReader(input.stream, packHash, end);
  try {
    return await read(pack, input.idx, end, packHash);
  } catch (error) {
    await pack.cancel();
    throw error;
  }
}

const read = async (
  pack: PackReader,
  idxBytes: Bytes,
  end: number,
  packHash: NodeCrypto.Hash,
): Promise<VerifiedPack> => {
  const header = await pack.take(12);
  if (u32(header, 0) !== 0x5041434b) throw new PackError("Not a pack.");
  if (u32(header, 4) !== 2 && u32(header, 4) !== 3)
    throw new PackError("Unsupported pack version.");

  const idx = await parsePackIndex(idxBytes);
  if (idx.entries.length !== u32(header, 8)) throw new PackError("Index and pack disagree.");
  const byOffset = [...idx.entries].sort((a, b) => a.offset - b.offset);
  // Entries back to back from the header to the checksum: nothing hides between them.
  if (byOffset.length > 0 && byOffset[0]!.offset !== 12) {
    throw new PackError("Index offsets are out of range.");
  }
  const offsetOf = new Map(idx.entries.map((entry) => [entry.oid, entry.offset]));
  /** Where each object starts: a delta's base must be one of these. */
  const entryAt = new Set(idx.entries.map((entry) => entry.offset));

  /** Each read object's type, by offset: what a delta against it resolves to. */
  const typeAt = new Map<number, ObjectType>();
  /** Commits' and folders' contents, by offset, the bases their deltas need. */
  const contentAt = new Map<number, Bytes>();
  const objects: Array<PackedObject> = [];
  const structure = new Map<Oid, { readonly type: "commit" | "tree"; readonly content: Bytes }>();
  const referenced = new Set<Oid>();
  /** Small deltas against an object later in the pack, resolved once it has been read. */
  const later: Array<{ offset: number; oid: Oid; length: number; base: number; data: Bytes }> = [];

  /** Records an object with known content, checking its id. */
  const settle = async (
    offset: number,
    oid: Oid,
    length: number,
    type: ObjectType,
    content: Bytes,
  ) => {
    if (idOf(type, content) !== oid) {
      throw new PackError(`Object ${oid} does not match its content.`);
    }
    typeAt.set(offset, type);
    objects.push({ oid, type, offset, length, size: content.length });
    if (type === "commit" || type === "tree") {
      contentAt.set(offset, content);
      structure.set(oid, { type, content });
      for (const ref of referencedOids(type, content)) referenced.add(ref);
    }
  };

  /** A delta's result: checked when its base is a commit or folder, recorded when a file. */
  const resolveDelta = async (
    offset: number,
    oid: Oid,
    length: number,
    base: number,
    data: Bytes,
  ) => {
    const baseType = typeAt.get(base)!;
    const baseContent = contentAt.get(base);
    if (baseContent !== undefined) {
      if (deltaSizes(data).result > MAX_HELD_BYTES) {
        throw new PackError(`A ${baseType} that big is more than a drive reads.`);
      }
      return settle(offset, oid, length, baseType, applyDelta(baseContent, data));
    }
    typeAt.set(offset, baseType);
    objects.push({ oid, type: baseType, offset, length, size: deltaSizes(data).result });
  };

  const baseOf = (offset: number, entry: EntryHeader) => {
    const base =
      entry.kind === "ofs_delta"
        ? offset - entry.baseDistance!
        : entry.kind === "ref_delta"
          ? offsetOf.get(entry.baseOid!)
          : undefined;
    if (base === undefined || !entryAt.has(base)) {
      throw new PackError("A delta's base is not in the pack.");
    }
    return base;
  };

  for (const [i, entry] of byOffset.entries()) {
    const next = byOffset[i + 1]?.offset ?? end;
    const length = next - entry.offset;
    if (pack.position !== entry.offset || length <= 0 || next > end) {
      throw new PackError("Index offsets are out of range.");
    }
    const first = await pack.take(Math.min(HEADER_BYTES, length));
    const head = readEntryHeader(first, 0);
    // Held only when small both ways: a few compressed bytes can inflate to gigabytes.
    if (length <= MAX_HELD_BYTES && head.size <= MAX_HELD_BYTES) {
      const bytes =
        first.length === length
          ? first
          : concatBytes([first, await pack.take(length - first.length)]);
      const data = await inflate(bytes.subarray(head.headerLength));
      if (data.length !== head.size) throw new PackError("Object size mismatch.");
      if (head.kind !== "ofs_delta" && head.kind !== "ref_delta") {
        await settle(entry.offset, entry.oid, length, head.kind, data);
        continue;
      }
      const base = baseOf(entry.offset, head);
      if (base < entry.offset) await resolveDelta(entry.offset, entry.oid, length, base, data);
      else later.push({ offset: entry.offset, oid: entry.oid, length, base, data });
      continue;
    }
    // Too big to hold: only a file may be, hashed (or, as a delta, sized) as it inflates.
    const rest = pack.stream(length - first.length);
    const compressed = first.subarray(head.headerLength);
    if (head.kind === "blob") {
      const hash = NodeCrypto.createHash("sha1");
      hash.update(encoder.encode(`blob ${head.size}\0`));
      const size = await inflateStreaming(compressed, rest, (bytes) => hash.update(bytes));
      if (size !== head.size) throw new PackError("Object size mismatch.");
      if (hash.digest("hex") !== entry.oid) {
        throw new PackError(`Object ${entry.oid} does not match its content.`);
      }
      typeAt.set(entry.offset, "blob");
      objects.push({ oid: entry.oid, type: "blob", offset: entry.offset, length, size });
      continue;
    }
    if (head.kind !== "ofs_delta" && head.kind !== "ref_delta") {
      throw new PackError(`A ${head.kind} that big is more than a drive reads.`);
    }
    const base = baseOf(entry.offset, head);
    if (typeAt.get(base) !== "blob") {
      throw new PackError("A big delta must be a file's, against a file before it.");
    }
    // The delta's first bytes say its result's size; the first inflated chunk may hold fewer.
    let start = new Uint8Array(0);
    const size = await inflateStreaming(compressed, rest, (bytes) => {
      if (start.length < HEADER_BYTES) start = concatBytes([start, bytes]).slice(0, HEADER_BYTES);
    });
    if (size !== head.size) throw new PackError("Object size mismatch.");
    typeAt.set(entry.offset, "blob");
    objects.push({
      oid: entry.oid,
      type: "blob",
      offset: entry.offset,
      length,
      size: deltaSizes(start).result,
    });
  }
  // Deltas against later objects, which may themselves be such deltas: resolved
  // until nothing moves; whatever is left leans on a cycle.
  for (let waiting = later; waiting.length > 0;) {
    const ready = waiting.filter((delta) => typeAt.has(delta.base));
    if (ready.length === 0) throw new PackError("A delta's base is not in the pack.");
    for (const delta of ready) {
      await resolveDelta(delta.offset, delta.oid, delta.length, delta.base, delta.data);
    }
    waiting = waiting.filter((delta) => !typeAt.has(delta.offset));
  }
  // A file delta isn't checked here, so it may never stand in for a folder or commit.
  for (const [, object] of structure) {
    const structural =
      object.type === "commit"
        ? (() => {
            const commit = parseCommit(object.content);
            return [commit.tree, ...commit.parents];
          })()
        : parseTree(object.content)
            .filter((entry) => entry.kind === "directory")
            .map((entry) => entry.oid);
    for (const oid of structural) {
      if (offsetOf.has(oid) && !structure.has(oid)) {
        throw new PackError(`${oid} is named as a folder or commit, but isn't one.`);
      }
    }
  }

  const checksum = hex(await pack.take(20));
  await pack.end();
  if (packHash.digest("hex") !== checksum) throw new PackError("Pack checksum mismatch.");
  if (idx.packChecksum !== checksum) throw new PackError("Index is for another pack.");
  const external = new Set([...referenced].filter((oid) => !offsetOf.has(oid)));
  return { name: checksum, objects, structure, external };
};
