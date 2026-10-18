// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - standalone CI tooling, without an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

export const RELEASE_TAG = "probe-1057-r4-5459d40b";
export const RELEASE_ID = 416_630_243;
export const ARCHIVE_SHA = "5459d40b16a6c26562b463092fd82082edd4bc93297c97698d45791674eff84a";
export const SOURCE_PIN = "002c311a136766f1ebc7be7ad65f5143667f5ffa";
const ARCHIVE_NAME = "pristine-r4-ci-inputs.tar.gz";
const ROOT = "1057-pristine-five-r1";
export const digest = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
};
export const json = async (path: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(path, "utf8"));
export const writeJson = async (path: string, value: unknown) => {
  await NodeFSP.writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await NodeFSP.rename(`${path}.tmp`, path);
};
export const textField = (value: unknown, field: string) => {
  const result = record(value)[field];
  if (typeof result !== "string" || !result) throw new Error(`Missing ${field}`);
  return result;
};

export async function downloadArchive(
  repository: string,
  tag: string,
  token: string,
  destination: string,
) {
  if (tag !== RELEASE_TAG || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid release source");
  const headers = { authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  // Draft tags are pending and cannot be resolved through the published-release tag endpoint.
  const release = await fetch(`https://api.github.com/repos/${repository}/releases/${RELEASE_ID}`, {
    headers,
  });
  if (!release.ok) throw new Error(`Release lookup HTTP ${release.status}`);
  const metadata = record(await release.json());
  if (
    metadata.id !== RELEASE_ID ||
    metadata.draft !== true ||
    metadata.tag_name !== RELEASE_TAG ||
    metadata.target_commitish !== SOURCE_PIN
  ) {
    throw new Error("Frozen draft release metadata mismatch");
  }
  const assets = metadata.assets;
  if (!Array.isArray(assets)) throw new Error("Release has no assets");
  const matches = assets.map(record).filter((asset) => asset.name === ARCHIVE_NAME);
  const asset = matches[0];
  if (matches.length !== 1 || !asset || typeof asset.id !== "number" || asset.size !== 21_893_763) {
    throw new Error("Frozen archive asset missing or wrong size");
  }
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
    {
      headers: { ...headers, accept: "application/octet-stream" },
    },
  );
  if (!response.ok) throw new Error(`Asset download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArchiveBytes(bytes);
  await NodeFSP.writeFile(destination, bytes);
}

export function verifyArchiveBytes(bytes: Uint8Array) {
  if (bytes.byteLength !== 21_893_763 || digest(bytes) !== ARCHIVE_SHA)
    throw new Error("Frozen archive SHA/size mismatch");
}

async function verifyFile(root: string, entry: unknown, prefix: string) {
  const item = record(entry);
  const name = textField(item, "name");
  if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid inventory path");
  const bytes = await NodeFSP.readFile(NodePath.join(root, prefix, name));
  if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
    throw new Error(`Inventory mismatch: ${prefix}/${name}`);
}

export async function verifyInventories(root: string) {
  const inventory = record(await json(NodePath.join(root, "inventory.json")));
  const source = record(await json(NodePath.join(root, "pinned-source-inventory.json")));
  if (inventory.sourcePin !== SOURCE_PIN || source.sourcePin !== SOURCE_PIN)
    throw new Error("Wrong source pin");
  const host = inventory.hostModules;
  const fixture = inventory.fixtureModules;
  const files = source.files;
  if (
    !Array.isArray(host) ||
    host.length !== 8 ||
    !Array.isArray(fixture) ||
    fixture.length !== 3 ||
    !Array.isArray(files) ||
    files.length !== 10
  ) {
    throw new Error("Wrong inventory counts");
  }
  for (const [entries, prefix] of [
    [host, "host/generated"],
    [fixture, "fixture"],
    [files, "host"],
  ] as const) {
    if (new Set(entries.map((entry) => textField(entry, "name"))).size !== entries.length)
      throw new Error("Duplicate inventory entry");
    for (const entry of entries) await verifyFile(root, entry, prefix);
  }
  await verifyFile(
    root,
    { ...record(inventory.fixtureManifest), name: "manifest.json" },
    "fixture",
  );
  const manifest = record(await json(NodePath.join(root, "fixture/manifest.json")));
  if (
    JSON.stringify(manifest.paths) !== '["/startup"]' ||
    manifest.mode !== "facet" ||
    Object.keys(record(manifest.modules)).length !== 3
  ) {
    throw new Error("Fixture is not the single cold startup control");
  }
  return { inventory, source, host: host.map(record) };
}

export async function unpackArchive(archive: string, destination: string) {
  verifyArchiveBytes(await NodeFSP.readFile(archive));
  // The fixed outer hash authenticates even unlisted archive files before extraction or execution.
  const entries = NodeChildProcess.execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  if (
    entries.some(
      (name) =>
        !name.startsWith(`${ROOT}/`) || name.split("/").includes("..") || name.startsWith("/"),
    )
  ) {
    throw new Error("Unsafe archive entry");
  }
  await NodeFSP.mkdir(destination, { recursive: true });
  NodeChildProcess.execFileSync("tar", ["-xzf", archive, "-C", destination]);
  const root = NodePath.join(destination, ROOT);
  const rejectLinks = async (dir: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Archive contains a symlink");
      if (entry.isDirectory()) await rejectLinks(NodePath.join(dir, entry.name));
      else if (!entry.isFile()) throw new Error("Archive contains a special file");
    }
  };
  await rejectLinks(root);
  await verifyInventories(root);
  return root;
}
