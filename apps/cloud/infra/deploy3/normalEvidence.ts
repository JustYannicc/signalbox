import {
  createLocalEvidenceDirectory,
  hashLocalEvidenceFile,
  readLocalEvidenceBytes,
  saveLocalEvidenceBytes,
  writeLocalEvidenceChunks,
  syncLocalEvidenceDirectory,
} from "./localEvidenceFiles.ts";
import * as Schema from "effect/Schema";
import {
  controlDigest,
  deploy3RegistrationSha256,
  type Deploy3ControlRegistration,
} from "./controlRegistry.ts";
import { boundedOperation } from "./platform.ts";
import { EvidenceEntries, inspectEvidenceInventory } from "./evidenceInventory.ts";
import {
  NativeStdioEvidence,
  exportNativeStdioEvidence,
  inspectLegacyLocalStdio,
  verifyNativeStdioEvidence,
} from "./nativeStdioEvidence.ts";

const Page = Schema.Struct({
  entries: Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])),
  next: Schema.NullOr(Schema.String),
});
const File = Schema.Struct({ name: Schema.String, bytes: Schema.Number, sha256: Schema.String });
const ManifestV1 = Schema.Struct({
  schema: Schema.Literal("sb1070/deploy3-local-export/v1"),
  runId: Schema.String,
  registrationSha256: Schema.String,
  inventorySha256: Schema.String,
  files: Schema.Array(File),
});
const ManifestV2 = Schema.Struct({
  schema: Schema.Literal("sb1070/deploy3-local-export/v2"),
  runId: Schema.String,
  registrationSha256: Schema.String,
  inventorySha256: Schema.String,
  files: Schema.Array(File),
  nativeStdio: Schema.Array(NativeStdioEvidence),
});
const decodePageJson = Schema.decodeSync(Schema.fromJsonString(Page));
const decodeManifestV1 = Schema.decodeUnknownSync(ManifestV1);
const decodeManifestV2 = Schema.decodeUnknownSync(ManifestV2);
const decodeEvidenceEntriesJson = Schema.decodeSync(Schema.fromJsonString(EvidenceEntries));

async function* responseChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Normal completion only. It never skips blobs or publishes their contents. */
export async function exportDeploy3Locally(input: {
  readonly origin: string;
  readonly qualifierRunId: string;
  readonly registration: Deploy3ControlRegistration;
  readonly directory: string;
  readonly fetchImpl?: typeof fetch;
}) {
  if (!input.registration) {
    throw new Error("Normal export requires the canonical deployment registration");
  }
  const runId = input.registration.runId;
  const registrationSha256 = await deploy3RegistrationSha256(input.registration);
  if (
    !/^[a-f0-9]{8}$/.test(runId) ||
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
  async function downloadBlob(
    artifact: { readonly id: string; readonly bytes: number; readonly sha256: string },
    name: string,
  ) {
    return boundedOperation(async (signal) => {
      const response = await fetchImpl(origin + "/export/blob", {
        method: "POST",
        signal,
        redirect: "error",
        cache: "no-store",
        headers: { "x-qualifier-run": input.qualifierRunId, "content-type": "application/json" },
        body: JSON.stringify(artifact),
      });
      if (response.status !== 200) throw new Error("Normal evidence export request failed");
      const chunks = response.body ? responseChunks(response.body) : emptyChunks();
      const file = await writeLocalEvidenceChunks(input.directory, name, chunks);
      if (file.bytes !== artifact.bytes || file.sha256 !== artifact.sha256) {
        throw new Error("Exported blob differs from its source reference");
      }
      return { name, bytes: file.bytes, sha256: file.sha256 };
    }, 60_000);
  }
  await createLocalEvidenceDirectory(input.directory);
  const before = await inventory();
  if (before.length === 0) throw new Error("Empty evidence cannot release this deployment");
  const files = [];
  const artifacts = inspectEvidenceInventory(before);
  const blobFiles = new Map<string, string>();
  for (const [index, artifact] of artifacts.entries()) {
    const name = `blob-${index}.bin`;
    files.push(await downloadBlob(artifact, name));
    blobFiles.set(artifact.id, name);
  }
  const serialized = JSON.stringify(before);
  if (artifacts.length === 0) throw new Error("Normal export found no evidence blobs");
  const inventoryBytes = new TextEncoder().encode(serialized);
  const inventoryFile = await saveLocalEvidenceBytes(
    input.directory,
    "inventory.json",
    inventoryBytes,
  );
  files.push(inventoryFile);
  const nativeStdio = await exportNativeStdioEvidence({
    directory: input.directory,
    entries: before,
    blobFiles,
    readBlob: async (id) => {
      const name = blobFiles.get(id);
      if (!name) throw new Error("Native stdio journal payload has no local blob file");
      return await readLocalEvidenceBytes(input.directory, name);
    },
  });
  // A stable complete inventory plus every blob proves the export has no omitted or changing source rows.
  if (serialized !== JSON.stringify(await inventory())) {
    throw new Error("Evidence changed while exporting");
  }
  const manifest = {
    schema: "sb1070/deploy3-local-export/v2",
    runId,
    registrationSha256,
    inventorySha256: inventoryFile.sha256,
    files,
    nativeStdio,
  };
  await saveLocalEvidenceBytes(
    input.directory,
    "manifest.json",
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  await syncLocalEvidenceDirectory(input.directory);
  return verifyDeploy3LocalExport(
    { directory: input.directory, registration: input.registration },
    { allowIncompleteStdio: true },
  );
}

async function* emptyChunks() {}

export async function verifyDeploy3LocalExport(
  input: {
    readonly directory: string;
    readonly registration: Deploy3ControlRegistration;
  },
  options: { readonly allowIncompleteStdio?: boolean } = {},
) {
  if (!input.registration) {
    throw new Error("Local export verification requires the canonical deployment registration");
  }
  const runId = input.registration.runId;
  const registrationSha256 = await deploy3RegistrationSha256(input.registration);
  const raw = new TextDecoder().decode(
    await readLocalEvidenceBytes(input.directory, "manifest.json"),
  );
  const rawManifest: unknown = JSON.parse(raw);
  const manifest =
    typeof rawManifest === "object" &&
    rawManifest !== null &&
    Reflect.get(rawManifest, "schema") === "sb1070/deploy3-local-export/v1"
      ? decodeManifestV1(rawManifest)
      : decodeManifestV2(rawManifest);
  if (
    manifest.runId !== runId ||
    manifest.registrationSha256 !== registrationSha256 ||
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
  const blobFiles = new Map<string, string>();
  for (const [index, artifact] of artifacts.entries())
    blobFiles.set(artifact.id, `blob-${index}.bin`);
  const readBlob = async (id: string) => {
    const name = blobFiles.get(id);
    if (!name) throw new Error("Native stdio journal payload has no local blob file");
    return await readLocalEvidenceBytes(input.directory, name);
  };
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
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("Local export manifest path is invalid");
    }
    const actual = await hashLocalEvidenceFile(input.directory, file.name);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error("Local exported file differs");
  }
  const nativeStdio =
    manifest.schema === "sb1070/deploy3-local-export/v2"
      ? await verifyNativeStdioEvidence({
          directory: input.directory,
          entries: inventory,
          blobFiles,
          readBlob,
          evidence: manifest.nativeStdio,
          allowIncomplete: options.allowIncompleteStdio === true,
        })
      : [];
  const stdioStatus =
    manifest.schema === "sb1070/deploy3-local-export/v1"
      ? await inspectLegacyLocalStdio({ entries: inventory, readBlob })
      : nativeStdio.length === 0
        ? ("no-native-stdio-records" as const)
        : nativeStdio.every((stream) => stream.complete)
          ? ("complete-native-stdio" as const)
          : ("incomplete-native-stdio" as const);
  return {
    verifiedLocalExportSha256: await controlDigest(raw),
    nativeStdio,
    stdioStatus,
  };
}
