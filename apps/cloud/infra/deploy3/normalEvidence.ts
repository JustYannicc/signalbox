import {
  createLocalEvidenceDirectory,
  readLocalEvidenceBytes,
  writeLocalEvidenceBytes,
  syncLocalEvidenceDirectory,
} from "./localEvidenceFiles.ts";
import * as Schema from "effect/Schema";
import { controlDigest } from "./controlRegistry.ts";
import { boundedOperation } from "./platform.ts";
import { EvidenceEntries, inspectEvidenceInventory } from "./evidenceInventory.ts";

const Page = Schema.Struct({
  entries: Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])),
  next: Schema.NullOr(Schema.String),
});
const File = Schema.Struct({ name: Schema.String, bytes: Schema.Number, sha256: Schema.String });
const Manifest = Schema.Struct({
  schema: Schema.Literal("sb1070/deploy3-local-export/v1"),
  runId: Schema.String,
  registrationSha256: Schema.String,
  inventorySha256: Schema.String,
  files: Schema.Array(File),
});
const bytesDigest = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const decodePageJson = Schema.decodeSync(Schema.fromJsonString(Page));
const decodeManifestJson = Schema.decodeSync(Schema.fromJsonString(Manifest));
const decodeEvidenceEntriesJson = Schema.decodeSync(Schema.fromJsonString(EvidenceEntries));

async function save(directory: string, name: string, bytes: Uint8Array) {
  await writeLocalEvidenceBytes(directory, name, bytes);
  const readback = await readLocalEvidenceBytes(directory, name);
  const sha256 = await bytesDigest(bytes);
  if (readback.length !== bytes.length || (await bytesDigest(readback)) !== sha256) {
    throw new Error("Local export readback differs");
  }
  return { name, bytes: bytes.length, sha256 };
}

/** Normal completion only. It never skips blobs or publishes their contents. */
export async function exportDeploy3Locally(input: {
  readonly origin: string;
  readonly qualifierRunId: string;
  readonly runId: string;
  readonly registrationSha256: string;
  readonly directory: string;
  readonly fetchImpl?: typeof fetch;
}) {
  if (
    !/^[a-f0-9]{8}$/.test(input.runId) ||
    !/^[a-f0-9]{64}$/.test(input.registrationSha256) ||
    !input.qualifierRunId ||
    new URL(input.origin).protocol !== "https:"
  ) {
    throw new Error("Normal export has no exact deployment identity");
  }
  const origin = new URL(input.origin).origin;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  async function request(path: string, body?: unknown) {
    return boundedOperation(async (signal) => {
      const response = await fetchImpl(origin + path, {
        method: body === undefined ? "GET" : "POST",
        signal,
        redirect: "error",
        cache: "no-store",
        headers: { "x-qualifier-run": input.qualifierRunId, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status !== 200) throw new Error("Normal evidence export request failed");
      return new Uint8Array(await response.arrayBuffer());
    }, 60_000);
  }
  async function inventory() {
    const entries: (readonly [string, unknown])[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
      const query = new URLSearchParams({ prefix: "" });
      if (cursor !== undefined) query.set("startAfter", cursor);
      const page = decodePageJson(new TextDecoder().decode(await request(`/export/page?${query}`)));
      if (page.entries.length > 32) throw new Error("Export page exceeds the source contract");
      for (const entry of page.entries) {
        if (!entry[0] || (entries.length > 0 && entry[0] <= entries[entries.length - 1]![0])) {
          throw new Error("Export inventory repeated or reordered a key");
        }
        entries.push(entry);
      }
      if (page.next === null) return entries;
      if (
        page.entries.length !== 32 ||
        page.next !== page.entries.at(-1)?.[0] ||
        (cursor !== undefined && page.next <= cursor)
      ) {
        throw new Error("Export inventory cursor did not advance");
      }
      cursor = page.next;
    }
    throw new Error("Normal export inventory exceeded its bound");
  }
  await createLocalEvidenceDirectory(input.directory);
  const before = await inventory();
  if (before.length === 0) throw new Error("Empty evidence cannot release this deployment");
  const files = [];
  const artifacts = inspectEvidenceInventory(before);
  for (const artifact of artifacts) {
    const bytes = await request("/export/blob", artifact);
    if (bytes.length !== artifact.bytes || (await bytesDigest(bytes)) !== artifact.sha256) {
      throw new Error("Exported blob differs from its source reference");
    }
    files.push(await save(input.directory, `blob-${files.length}.bin`, bytes));
  }
  // A stable complete inventory plus every blob proves the export has no omitted or changing source rows.
  const serialized = JSON.stringify(before);
  if (serialized !== JSON.stringify(await inventory()) || artifacts.length === 0) {
    throw new Error("Evidence changed while exporting or has no blobs");
  }
  const inventoryBytes = new TextEncoder().encode(serialized);
  const inventoryFile = await save(input.directory, "inventory.json", inventoryBytes);
  files.push(inventoryFile);
  const manifest = {
    schema: "sb1070/deploy3-local-export/v1",
    runId: input.runId,
    registrationSha256: input.registrationSha256,
    inventorySha256: inventoryFile.sha256,
    files,
  };
  await save(input.directory, "manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  await syncLocalEvidenceDirectory(input.directory);
  return verifyDeploy3LocalExport(input);
}

export async function verifyDeploy3LocalExport(input: {
  readonly directory: string;
  readonly runId: string;
  readonly registrationSha256: string;
}) {
  const raw = new TextDecoder().decode(
    await readLocalEvidenceBytes(input.directory, "manifest.json"),
  );
  const manifest = decodeManifestJson(raw);
  if (
    manifest.runId !== input.runId ||
    manifest.registrationSha256 !== input.registrationSha256 ||
    manifest.files.length < 2 ||
    new Set(manifest.files.map((file) => file.name)).size !== manifest.files.length ||
    manifest.files.filter(
      (file) => file.name === "inventory.json" && file.sha256 === manifest.inventorySha256,
    ).length !== 1
  ) {
    throw new Error("Local evidence manifest identity differs");
  }
  const inventory = decodeEvidenceEntriesJson(
    new TextDecoder().decode(await readLocalEvidenceBytes(input.directory, "inventory.json")),
  );
  const artifacts = inspectEvidenceInventory(inventory);
  if (manifest.files.length !== artifacts.length + 1)
    throw new Error("Local export omitted source blobs");
  for (const [index, file] of manifest.files.entries()) {
    const expected = artifacts[index];
    if (
      index < artifacts.length &&
      (!expected ||
        file.name !== `blob-${index}.bin` ||
        file.bytes !== expected.bytes ||
        file.sha256 !== expected.sha256)
    ) {
      throw new Error("Local export blob differs from its complete source inventory");
    }
    if (
      !/^(blob-\d+\.bin|inventory\.json)$/.test(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw new Error("Local export manifest path is invalid");
    }
    const bytes = await readLocalEvidenceBytes(input.directory, file.name);
    if (bytes.length !== file.bytes || (await bytesDigest(bytes)) !== file.sha256)
      throw new Error("Local exported file differs");
  }
  return { verifiedLocalExportSha256: await controlDigest(raw) };
}
