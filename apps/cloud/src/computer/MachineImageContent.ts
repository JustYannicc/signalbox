import {
  isCanonicalMachinePath,
  validateMachineProgramInventory,
  type MachineProgramInventory,
} from "./MachineProgramInventory.ts";

export type { MachineImageContent } from "./machineFiles/ImageContent.ts";

const HEX = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Retain one private byte copy. Callers receive slices and cannot mutate later reads. */
export function createMachineImageContentReader(inventory: MachineProgramInventory) {
  let prepared: Promise<ReadonlyMap<string, Uint8Array>> | undefined;
  return async (path: string, offset: number, length: number) => {
    if (inventory.imageContent === undefined) return undefined;
    if (
      Array.isArray(inventory.imageContent.entries) &&
      !inventory.imageContent.entries.some((entry) => entry?.path === path)
    )
      return undefined;
    prepared ??= prepare(inventory);
    const bytes = (await prepared).get(path);
    return bytes?.slice(offset, offset + Math.min(length, bytes.byteLength));
  };
}

async function prepare(inventory: MachineProgramInventory) {
  validateMachineProgramInventory(inventory);
  const { imageContent: content, ...metadata } = inventory;
  if (
    content?.format !== "signalbox-machine-image-content-v1" ||
    content.includeRule !== "regular-files-under-/etc" ||
    content.imageDigest !== inventory.imageDigest ||
    content.captureSha256 !== inventory.provenance.captureSha256 ||
    !HEX.test(content.captureSha256) ||
    !HEX.test(content.inventorySha256) ||
    !HEX.test(inventory.provenance.snapshotSha256 ?? "") ||
    !Array.isArray(content.entries) ||
    content.fileCount !== content.entries.length
  )
    throw new TypeError("Image content identity or capture provenance differs from inventory");

  // Copy the manifest before the first await so an external mutation cannot change validation inputs.
  const inventoryJson = JSON.stringify(metadata);
  const inventorySha256 = content.inventorySha256;
  const entries = content.entries.map((entry) => ({ ...entry }));
  const totalBytes = content.totalBytes;
  const included = metadata.entries.filter(
    (entry) => entry.type === "file" && entry.path.startsWith("/etc/"),
  );
  if (entries.length !== included.length)
    throw new TypeError("Image content does not cover the include rule");
  const bytesByPath = new Map<string, Uint8Array>();
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const file = included[index];
    if (
      !entry ||
      !isCanonicalMachinePath(entry.path) ||
      !entry.path.startsWith("/etc/") ||
      file === undefined ||
      file.path !== entry.path ||
      file.size !== entry.size ||
      bytesByPath.has(entry.path) ||
      !HEX.test(entry.sha256) ||
      typeof entry.bytesBase64 !== "string" ||
      !BASE64.test(entry.bytesBase64)
    )
      throw new TypeError("Image content path, size, encoding or hash is invalid");
    if (
      BigInt(entry.size) + BigInt(total) > 1024n * 1024n ||
      entry.bytesBase64.length !== 4 * Math.ceil(Number(entry.size) / 3)
    )
      throw new TypeError("Image content encoding exceeds its size or capture budget");
    const decoded = atob(entry.bytesBase64);
    if (btoa(decoded) !== entry.bytesBase64)
      throw new TypeError("Image content encoding is not canonical");
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (String(bytes.byteLength) !== entry.size)
      throw new TypeError(`Image content size differs: ${entry.path}`);
    total += bytes.byteLength;
    if (total > 1024 * 1024) throw new TypeError("Image content exceeds the 1 MiB budget");
    bytesByPath.set(entry.path, bytes);
  }
  if (total !== totalBytes) throw new TypeError("Image content total differs");
  if ((await sha256(new TextEncoder().encode(inventoryJson))) !== inventorySha256)
    throw new TypeError("Image content inventory hash differs");
  for (const entry of entries) {
    if ((await sha256(bytesByPath.get(entry.path)!)) !== entry.sha256)
      throw new TypeError(`Image content hash differs: ${entry.path}`);
  }
  return bytesByPath;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
