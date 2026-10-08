import * as Hex from "effect/encoding/Hex";

/**
 * Git's object model, enough for a drive: hashing, and reading commits and
 * trees. Pure and runtime-neutral (Workers and Node), so the Worker can read a
 * drive without git.
 */

/** Bytes on a plain `ArrayBuffer`, which WebCrypto and `Blob` accept. */
export type Bytes = Uint8Array<ArrayBuffer>;

export type ObjectType = "commit" | "tree" | "blob" | "tag";

/** A 40-character lowercase SHA-1 object id. */
export type Oid = string;

const isOid = (value: unknown): value is Oid =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const hex = (bytes: Uint8Array) => Hex.encode(bytes);

export const concatBytes = (parts: ReadonlyArray<Uint8Array>): Bytes => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export const sha1 = async (bytes: Bytes) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));

/** The id git gives `content` stored as `type`. */
export const objectId = (type: ObjectType, content: Bytes) =>
  sha1(concatBytes([encoder.encode(`${type} ${content.length}\0`), content]));

/** Inflates one zlib stream (git's object compression). */
export async function inflate(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly time: number;
}

export interface Commit {
  readonly tree: Oid;
  readonly parents: ReadonlyArray<Oid>;
  readonly author: Signature;
  readonly message: string;
}

const SIGNATURE = /^(.*) <(.*)> (\d+) [+-]\d{4}$/;

const parseSignature = (line: string): Signature => {
  const match = SIGNATURE.exec(line);
  return match === null
    ? { name: line, email: "", time: 0 }
    : { name: match[1] ?? "", email: match[2] ?? "", time: Number(match[3]) };
};

export function parseCommit(content: Bytes): Commit {
  const text = decoder.decode(content);
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  let tree: Oid | null = null;
  const parents: Array<Oid> = [];
  let author: Signature = { name: "", email: "", time: 0 };
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = parseSignature(line.slice(7));
  }
  if (tree === null || !isOid(tree) || !parents.every(isOid)) {
    throw new Error("Malformed commit.");
  }
  return { tree, parents, author, message: split === -1 ? "" : text.slice(split + 2) };
}

export type TreeEntryKind = "file" | "executable" | "symlink" | "directory" | "submodule";

export interface TreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly kind: TreeEntryKind;
  readonly oid: Oid;
}

const kindOf = (mode: string): TreeEntryKind => {
  switch (mode) {
    case "40000":
      return "directory";
    case "100755":
      return "executable";
    case "120000":
      return "symlink";
    case "160000":
      return "submodule";
    default:
      return "file";
  }
};

export function parseTree(content: Bytes): ReadonlyArray<TreeEntry> {
  const entries: Array<TreeEntry> = [];
  let at = 0;
  while (at < content.length) {
    const space = content.indexOf(0x20, at);
    const nul = content.indexOf(0, space);
    if (space === -1 || nul === -1 || nul + 21 > content.length) {
      throw new Error("Malformed tree.");
    }
    const mode = decoder.decode(content.subarray(at, space));
    entries.push({
      mode,
      kind: kindOf(mode),
      name: decoder.decode(content.subarray(space + 1, nul)),
      oid: hex(content.subarray(nul + 1, nul + 21)),
    });
    at = nul + 21;
  }
  return entries;
}

/** Objects a commit or tree points at, which must exist for it to be readable. */
export function referencedOids(type: ObjectType, content: Bytes): ReadonlyArray<Oid> {
  if (type === "commit") {
    const commit = parseCommit(content);
    return [commit.tree, ...commit.parents];
  }
  if (type === "tree") {
    // Submodule entries name commits in another repository.
    return parseTree(content)
      .filter((entry) => entry.kind !== "submodule")
      .map((entry) => entry.oid);
  }
  return [];
}
