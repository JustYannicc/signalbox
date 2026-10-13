import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";

import {
  type Bytes,
  concatBytes as concat,
  objectId,
  type ObjectType,
  type Oid,
  sha1,
  type TreeEntry,
} from "./gitObjects.ts";

/**
 * Writing git objects and packs, enough for the Worker to make commits of its
 * own: splitting a folder out of a drive. Packs are plain (no deltas), version
 * 2 with a version 2 index, which `verifyPack` and git both read. Pure and
 * runtime-neutral, like `gitObjects.ts`.
 */

const encoder = new TextEncoder();

const fromHex = (oid: Oid) => Result.getOrThrow(Hex.decode(oid));

const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

/** A tree's content. Entries keep the order given: callers edit trees git already sorted. */
export const encodeTree = (entries: ReadonlyArray<TreeEntry>): Bytes =>
  concat(
    entries.flatMap((entry) => [
      encoder.encode(`${entry.mode} ${entry.name}\0`),
      fromHex(entry.oid),
    ]),
  );

export interface CommitInput {
  readonly tree: Oid;
  readonly parents: ReadonlyArray<Oid>;
  readonly author: { readonly name: string; readonly email: string; readonly time: number };
  readonly message: string;
}

/** A commit's content, committed by its author, in UTC. */
export const encodeCommit = (commit: CommitInput): Bytes => {
  const who = `${commit.author.name} <${commit.author.email}> ${commit.author.time} +0000`;
  return encoder.encode(
    [
      `tree ${commit.tree}`,
      ...commit.parents.map((parent) => `parent ${parent}`),
      `author ${who}`,
      `committer ${who}`,
      "",
      commit.message,
    ].join("\n"),
  );
};

export interface WrittenObject {
  readonly oid: Oid;
  readonly type: ObjectType;
  readonly content: Bytes;
}

export const writtenObject = async (type: ObjectType, content: Bytes): Promise<WrittenObject> => ({
  oid: await objectId(type, content),
  type,
  content,
});

/** Deflates with zlib framing, as git stores objects. */
async function deflate(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const TYPE_CODES: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** An entry's header: type and inflated size, as a little-endian base-128 varint. */
const entryHeader = (type: ObjectType, size: number) => {
  const bytes = [(TYPE_CODES[type] << 4) | (size & 0x0f)];
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes[bytes.length - 1]! |= 0x80;
    bytes.push(rest & 0x7f);
    rest = Math.floor(rest / 128);
  }
  return Uint8Array.from(bytes);
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A pack of `objects`, each once, and its index. Named by its checksum, as git names packs. */
export async function writePack(objects: ReadonlyArray<WrittenObject>) {
  const unique = [...new Map(objects.map((object) => [object.oid, object])).values()];
  const entries: Array<Uint8Array> = [];
  const index: Array<{ readonly oid: Oid; readonly offset: number; readonly crc: number }> = [];
  let offset = 12;
  for (const object of unique) {
    const entry = concat([
      entryHeader(object.type, object.content.length),
      await deflate(object.content),
    ]);
    index.push({ oid: object.oid, offset, crc: crc32(entry) });
    entries.push(entry);
    offset += entry.length;
  }
  const body = concat([encoder.encode("PACK"), u32(2), u32(unique.length), ...entries]);
  const checksum = await sha1(body);
  const pack = concat([body, fromHex(checksum)]);

  const sorted = [...index].sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const fanout = Array.from({ length: 256 }, () => 0);
  for (const { oid } of sorted) fanout[Number.parseInt(oid.slice(0, 2), 16)]!++;
  for (let i = 1; i < 256; i++) fanout[i]! += fanout[i - 1]!;
  const idxBody = concat([
    Uint8Array.from([0xff, 0x74, 0x4f, 0x63]),
    u32(2),
    ...fanout.map(u32),
    ...sorted.map((entry) => fromHex(entry.oid)),
    ...sorted.map((entry) => u32(entry.crc)),
    ...sorted.map((entry) => u32(entry.offset)),
    fromHex(checksum),
  ]);
  const idx = concat([idxBody, fromHex(await sha1(idxBody))]);
  return { name: checksum, pack, idx };
}
