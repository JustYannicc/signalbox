const magic = new TextEncoder().encode("SBASSET1");
const prefixBytes = 12;
const maxBundleBytes = 8 * 1024 * 1024;
const maxHeaderBytes = 256 * 1024;
const maxEntries = 512;
const sha256Pattern = /^[0-9a-f]{64}$/;

export type AssetBundleEntry = {
  path: string;
  bytes: Uint8Array;
  sha256: string;
};

type CatalogEntry = { bytes: number; sha256: string };
type MetadataEntry = CatalogEntry & { path: string };

function fail(reason: string): never {
  throw new Error(`Invalid Claude asset bundle: ${reason}`);
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(descriptor.bytes) &&
    typeof descriptor.bytes === "number" &&
    descriptor.bytes >= 0 &&
    descriptor.bytes <= maxBundleBytes &&
    typeof descriptor.sha256 === "string" &&
    sha256Pattern.test(descriptor.sha256)
  );
}

// Wire layout: eight ASCII magic bytes, a big-endian uint32 JSON length, JSON, raw bodies.
export function encodeAssetBundle(entries: readonly AssetBundleEntry[]): Uint8Array {
  if (entries.length > maxEntries) fail("too many entries");
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const paths = new Set<string>();
  const metadata = sorted.map(({ path, bytes, sha256 }) => {
    if (!path || paths.has(path)) fail("empty or duplicate path");
    paths.add(path);
    if (!isCatalogEntry({ bytes: bytes.byteLength, sha256 })) fail(`bad descriptor for ${path}`);
    return { path, bytes: bytes.byteLength, sha256 };
  });
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  if (header.byteLength > maxHeaderBytes) fail("header too large");
  const size =
    prefixBytes +
    header.byteLength +
    sorted.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (size > maxBundleBytes) fail("bundle too large");
  const bundle = new Uint8Array(size);
  bundle.set(magic);
  new DataView(bundle.buffer).setUint32(magic.byteLength, header.byteLength);
  bundle.set(header, prefixBytes);
  let offset = prefixBytes + header.byteLength;
  for (const entry of sorted) {
    bundle.set(entry.bytes, offset);
    offset += entry.bytes.byteLength;
  }
  return bundle;
}

// The fixed release catalog is trusted configuration. No file writes happen until this resolves.
// Bodies reference a decoder-owned snapshot, so later mutation of the request cannot change them.
export async function decodeVerifiedAssetBundle(
  input: Uint8Array,
  expectedCatalog: Readonly<Record<string, CatalogEntry>>,
): Promise<AssetBundleEntry[]> {
  if (input.byteLength > maxBundleBytes) fail("bundle too large");
  if (input.byteLength < prefixBytes) fail("truncated prefix");
  const bundle = Uint8Array.from(input);
  if (!magic.every((byte, index) => bundle[index] === byte)) fail("wrong magic");
  const headerLength = new DataView(bundle.buffer).getUint32(magic.byteLength);
  if (headerLength > maxHeaderBytes) fail("header too large");
  const bodyStart = prefixBytes + headerLength;
  if (bodyStart > bundle.byteLength) fail("truncated header");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bundle.subarray(prefixBytes, bodyStart)),
    );
  } catch {
    fail("malformed header");
  }
  if (!Array.isArray(parsed) || parsed.length > maxEntries) fail("invalid entry list");
  const expected = new Map(Object.entries(expectedCatalog));
  if (expected.size > maxEntries || parsed.length !== expected.size)
    fail("catalog coverage mismatch");
  const seen = new Set<string>();
  const metadata: MetadataEntry[] = [];
  let end = bodyStart;
  for (const value of parsed) {
    if (
      !isCatalogEntry(value) ||
      !("path" in value) ||
      typeof value.path !== "string" ||
      Object.keys(value).length !== 3
    ) {
      fail("invalid entry metadata");
    }
    const path = value.path;
    if (!path || seen.has(path)) fail("empty or duplicate path");
    seen.add(path);
    const descriptor = expected.get(path);
    if (
      !isCatalogEntry(descriptor) ||
      descriptor.bytes !== value.bytes ||
      descriptor.sha256 !== value.sha256
    ) {
      fail(`catalog mismatch for ${path}`);
    }
    end += value.bytes;
    if (end > bundle.byteLength) fail("truncated bodies");
    metadata.push({ path, bytes: value.bytes, sha256: value.sha256 });
  }
  if (end !== bundle.byteLength) fail("trailing bytes");
  const entries: AssetBundleEntry[] = [];
  let offset = bodyStart;
  for (const entry of metadata) {
    const bytes = bundle.subarray(offset, offset + entry.bytes);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== entry.sha256) fail(`hash mismatch for ${entry.path}`);
    entries.push({ path: entry.path, bytes, sha256 });
    offset += entry.bytes;
  }
  return entries;
}
