import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { sha256, verifyPinnedBytes, writePinnedTarFiles } from "./productProgramArchive.ts";
import { writeOnce } from "./productProgramRuntime.ts";
import type {
  AssetPin,
  ProductProgramPinSnapshot,
  ProgramManifest,
} from "./productProgramTypes.ts";

export const PUBLISHED_ROOT = "https://github.com/JustYannicc/signalbox/releases/download";
export const RELEASE_MANIFESTS = Object.freeze([
  {
    tag: "kernel-programs-20261027-ugrep-c402734f",
    bytes: 8_841,
    sha256: "2d4328af7f15af3addfe757b1227fe5f66383f62938fd6f3491b6448d6f9a889",
  },
  {
    tag: "kernel-programs-20261023-sed-40c8bb93",
    bytes: 7_265,
    sha256: "eefbaeac35faca9f993bc13e392a49412f3585c7abb16db7a27f21f0aff92ac5",
  },
]);
const RELEASE_ASSET_TAGS = Object.freeze({
  bash: "kernel-programs-20261022-c3e8dc79-791b862a",
  busybox: "kernel-programs-20261023-6aefd645-2d079609",
  ripgrep: "kernel-programs-20261019-17caf644-791b862a",
  coreutils: "kernel-programs-20261023-6aefd645-2d079609",
  ugrep: "kernel-programs-20261027-ugrep-c402734f",
  sed: "kernel-programs-20261023-sed-40c8bb93",
});
const RELEASED_PROGRAMS = Object.freeze([
  { manifest: 0, name: "bash", output: "bash.wasm", provenance: "bash.provenance.json" },
  { manifest: 0, name: "busybox", output: "busybox.wasm", provenance: "busybox.provenance.json" },
  { manifest: 0, name: "ripgrep", output: "rg.wasm", provenance: "ripgrep.provenance.json" },
  {
    manifest: 0,
    name: "coreutils",
    output: "coreutils.tar",
    provenance: "coreutils.provenance.json",
  },
  { manifest: 0, name: "ugrep", output: "ugrep.wasm", provenance: "ugrep.provenance.json" },
  { manifest: 1, name: "sed", output: "sed.wasm", provenance: "sed.provenance.json" },
]);

export async function fetchPinned(
  fetchAsset: typeof fetch,
  pin: { readonly url: string; readonly bytes: number; readonly sha256: string },
  label: string,
): Promise<Uint8Array> {
  requireHttps(pin.url, label);
  const response = await fetchAsset(pin.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`PRODUCT_PROGRAM_DOWNLOAD_FAILED:${label}:${response.status}`);
  requireHttps(response.url || pin.url, label);
  const bytes = await readResponseBytes(response, pin.bytes, label);
  verifyPinnedBytes(bytes, pin, label);
  return bytes;
}

export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`PRODUCT_PROGRAM_DOWNLOAD_TOO_LARGE:${label}`);
  }
  if (!response.body) throw new Error(`PRODUCT_PROGRAM_DOWNLOAD_BODY_MISSING:${label}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`PRODUCT_PROGRAM_DOWNLOAD_TOO_LARGE:${label}`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

export function parseProgramManifest(bytes: Uint8Array, label = "program-inputs"): ProgramManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`PRODUCT_PROGRAM_MANIFEST_INVALID:${label}`, { cause });
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.programs))
    throw new Error(`PRODUCT_PROGRAM_MANIFEST_INVALID:${label}`);
  const programs: Record<string, AssetPin> = {};
  for (const [name, raw] of Object.entries(value.programs)) {
    if (!isRecord(raw)) throw new Error(`PRODUCT_PROGRAM_MANIFEST_ENTRY_INVALID:${label}:${name}`);
    const asset = parseAssetPin(raw, `${label}:${name}`);
    const provenance = raw.provenance;
    programs[name] = {
      ...asset,
      ...(provenance === undefined
        ? {}
        : { provenance: provenancePin(provenance, `${label}:${name}:provenance`) }),
    };
  }
  return { schemaVersion: 1, programs };
}

function parseAssetPin(value: unknown, label: string): AssetPin {
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error(`PRODUCT_PROGRAM_ASSET_PIN_INVALID:${label}`);
  }
  requireHttps(value.url, label);
  return { url: value.url, bytes: value.bytes, sha256: value.sha256 };
}

function provenancePin(value: unknown, label: string): AssetPin & { readonly sourceUrl?: string } {
  const pin = parseAssetPin(value, label);
  if (!isRecord(value) || value.sourceUrl === undefined) return pin;
  if (typeof value.sourceUrl !== "string")
    throw new Error(`PRODUCT_PROGRAM_ASSET_PIN_INVALID:${label}`);
  requireHttps(value.sourceUrl, `${label}:source`);
  return { ...pin, sourceUrl: value.sourceUrl };
}

export async function downloadPublishedPrograms(
  fetchAsset: typeof fetch,
  output: string,
  manifests: readonly ProgramManifest[],
  pins: ProductProgramPinSnapshot,
) {
  const archives = new Map<string, string>();
  const receipts = [];
  for (const source of RELEASED_PROGRAMS) {
    const manifest = manifests[source.manifest];
    const entry = manifest?.programs[source.name];
    if (!entry) throw new Error(`PRODUCT_PROGRAM_RELEASE_ENTRY_MISSING:${source.name}`);
    const expected = source.name === "coreutils" ? undefined : pins.files[source.name];
    if (expected && (entry.bytes !== expected.bytes || entry.sha256 !== expected.sha256))
      throw new Error(`PRODUCT_PROGRAM_RELEASE_PIN_DRIFT:${source.name}`);
    const expectedRelease = RELEASE_ASSET_TAGS[source.name as keyof typeof RELEASE_ASSET_TAGS];
    if (!expectedRelease || !entry.url.startsWith(`${PUBLISHED_ROOT}/${expectedRelease}/`))
      throw new Error(`PRODUCT_PROGRAM_RELEASE_URL_DRIFT:${source.name}`);
    if (
      !entry.provenance ||
      !entry.provenance.url.startsWith(`${PUBLISHED_ROOT}/${expectedRelease}/`)
    ) {
      throw new Error(`PRODUCT_PROGRAM_PROVENANCE_URL_DRIFT:${source.name}`);
    }
    const bytes = await fetchPinned(fetchAsset, entry, source.name);
    const outputs =
      source.name === "coreutils"
        ? Object.values(pins.coreutils.commands).map(({ file, bytes, sha256 }) => ({
            file,
            bytes,
            sha256,
          }))
        : [{ file: source.output, bytes: entry.bytes, sha256: entry.sha256 }];
    if (source.name === "coreutils") {
      const archivePath = NodePath.join(output, ".work", "coreutils.tar");
      await NodeFSP.writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
      archives.set(source.name, archivePath);
    } else {
      await writeOnce(NodePath.join(output, source.output), bytes);
    }
    if (!entry.provenance) throw new Error(`PRODUCT_PROGRAM_PROVENANCE_MISSING:${source.name}`);
    const provenance = await fetchPinned(fetchAsset, entry.provenance, `${source.name}:provenance`);
    if (
      source.name === "coreutils" &&
      (provenance.byteLength !== pins.coreutilsProvenance.bytes ||
        sha256(provenance) !== pins.coreutilsProvenance.sha256)
    ) {
      throw new Error("PRODUCT_PROGRAM_COREUTILS_PROVENANCE_DRIFT");
    }
    await writeOnce(NodePath.join(output, source.provenance), provenance);
    receipts.push({
      name: source.name,
      sourceUrl: entry.url,
      sourceBytes: entry.bytes,
      sourceSha256: entry.sha256,
      provenanceFile: source.provenance,
      provenanceBytes: provenance.byteLength,
      provenanceSha256: sha256(provenance),
      outputs,
    });
  }
  return { coreutilsArchive: archives.get("coreutils")!, receipts };
}

export async function extractCoreutils(
  archivePath: string,
  output: string,
  pins: ProductProgramPinSnapshot,
) {
  const files = Object.values(pins.coreutils.commands).map((pin) => ({
    member: `coreutils/${NodePath.basename(pin.file)}`,
    path: pin.file,
    bytes: pin.bytes,
    sha256: pin.sha256,
    mode: 0o444,
  }));
  await writePinnedTarFiles({ archivePath, root: output, files });
}

export function requireHttps(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`PRODUCT_PROGRAM_URL_INVALID:${label}`, { cause });
  }
  if (url.protocol !== "https:") throw new Error(`PRODUCT_PROGRAM_URL_INVALID:${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
