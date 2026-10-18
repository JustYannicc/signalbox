// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - standalone Node release downloader and CLI.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { extract } from "./extract.ts";

export const releaseBase =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
export const requiredVersions = ["2.1.113", "2.1.200", "2.1.250", "2.1.302"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function binaryHash(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function extractRelease(version: string, directory: string, platform = "linux-x64") {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^(linux-x64|darwin-arm64|win32-x64)$/.test(platform))
    throw new Error("Invalid release/version target");
  const response = await fetch(`${releaseBase}/${version}/manifest.json`);
  if (!response.ok) throw new Error(`Release manifest ${version}: HTTP ${response.status}`);
  const manifest: unknown = await response.json();
  if (!record(manifest) || manifest.version !== version || !record(manifest.platforms))
    throw new Error("Invalid official release manifest");
  const artifact = manifest.platforms[platform];
  if (
    !record(artifact) ||
    typeof artifact.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.checksum) ||
    typeof artifact.size !== "number" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    !["claude", "claude.exe"].includes(String(artifact.binary))
  )
    throw new Error("Invalid official binary metadata");
  await NodeFSP.mkdir(directory, { recursive: true });
  const binary = NodePath.join(directory, `claude-${version}-${platform}`);
  const existing = await NodeFSP.stat(binary).catch(() => undefined);
  if (!existing) {
    const download = await fetch(`${releaseBase}/${version}/${platform}/${artifact.binary}`);
    if (!download.ok || !download.body) throw new Error(`Binary download: HTTP ${download.status}`);
    const partial = `${binary}.partial-${process.pid}`;
    const file = await NodeFSP.open(partial, "wx");
    try {
      for await (const chunk of download.body) await file.writeFile(chunk);
      await file.close();
      if (
        (await NodeFSP.stat(partial)).size !== artifact.size ||
        (await binaryHash(partial)) !== artifact.checksum
      )
        throw new Error(`Official release checksum mismatch: ${version}/${platform}`);
      await NodeFSP.rename(partial, binary);
    } finally {
      await file.close();
      await NodeFSP.rm(partial, { force: true });
    }
  }
  if (
    (await NodeFSP.stat(binary)).size !== artifact.size ||
    (await binaryHash(binary)) !== artifact.checksum
  )
    throw new Error(`Official release checksum mismatch: ${version}/${platform}`);
  const output = NodePath.join(directory, `graph-${version}-${platform}`);
  const result = await extract(binary, output);
  await NodeFSP.writeFile(
    NodePath.join(output, ".bun-data/release.json"),
    `${JSON.stringify({ version, platform, source: `${releaseBase}/${version}/${platform}/${artifact.binary}`, manifest }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      version,
      platform,
      binary: result.binary,
      graph: result.graph,
      modules: result.modules.length,
      output,
    }),
  );
  return output;
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [directory, versions = requiredVersions.join(","), platform = "linux-x64"] =
    process.argv.slice(2);
  if (!directory)
    throw new Error(
      "Usage: node releases.ts <artifact-directory> [versions-comma-separated|latest] [platform]",
    );
  const selected =
    versions === "latest"
      ? [
          (
            await fetch(`${releaseBase}/latest`).then((r) => {
              if (!r.ok) throw new Error(`Latest release: HTTP ${r.status}`);
              return r.text();
            })
          ).trim(),
        ]
      : versions.split(",");
  for (const version of selected) await extractRelease(version, directory, platform);
}
