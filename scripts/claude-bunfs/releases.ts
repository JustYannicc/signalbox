// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - standalone Node release downloader and CLI.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { extract } from "./extract.ts";

export const releaseBase =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
export const requiredVersions = ["2.1.113", "2.1.200", "2.1.250", "2.1.302"];

export type CanarySelection = "" | "latest";

export function selectedVersions(selection: CanarySelection, latest: string) {
  return selection === "latest" ? [latest] : [...new Set([...requiredVersions, latest])];
}

export type ExtractReleaseOptions = {
  materialize?: boolean;
  discardDownloadedBinary?: boolean;
};

export type ExtractReleaseResult = {
  directory: string;
  downloadBytes: number;
  binarySha256: string;
  serializedGraphBytes: number;
  moduleRegionBytes: number;
  materializedPayloadBytes: number;
  retainedReleaseBytes: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function binaryHash(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await NodeFSP.stat(path)).size;
  }
  return bytes;
}

export function logDiskUsage(stage: string, directory: string, version?: string) {
  const result = NodeChildProcess.spawnSync("df", ["-hP", directory], { encoding: "utf8" });
  const lines = result.status === 0 ? result.stdout.trim().split(/\r?\n/) : [];
  const header = lines[0]?.toLowerCase() ?? "";
  const fields = lines.at(-1)?.trim().split(/\s+/);
  const unit = header.includes("512-blocks")
    ? "512-byte blocks"
    : /(?:1024|1k)-blocks/.test(header)
      ? "1024-byte blocks"
      : "df -h display";
  process.stdout.write(
    `${JSON.stringify({
      event: "canary-disk-usage",
      command: "df -hP",
      stage,
      ...(version ? { version } : {}),
      ...(fields && fields.length >= 5
        ? { total: fields[1], used: fields[2], available: fields[3], capacity: fields[4], unit }
        : { status: "unavailable" }),
    })}\n`,
  );
}

async function removeOwned(paths: readonly string[]) {
  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      await NodeFSP.rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function downloadBinary(
  url: string,
  binary: string,
  version: string,
  platform: string,
  expectedBytes: number,
  expectedHash: string,
) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Binary download: HTTP ${response.status}`);
  const partial = `${binary}.partial-${process.pid}`;
  let file: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
  let ownsPartial = false;
  try {
    file = await NodeFSP.open(partial, "wx");
    ownsPartial = true;
    for await (const chunk of response.body) await file.writeFile(chunk);
    await file.close();
    file = undefined;
    if (
      (await NodeFSP.stat(partial)).size !== expectedBytes ||
      (await binaryHash(partial)) !== expectedHash
    ) {
      throw new Error(`Official release checksum mismatch: ${version}/${platform}`);
    }
    await NodeFSP.rename(partial, binary);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (file) {
      try {
        await file.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (ownsPartial) {
      try {
        await NodeFSP.rm(partial, { force: true });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Official release download failed and partial-input cleanup was incomplete.",
      );
    }
    throw error;
  }
}

export async function extractRelease(
  version: string,
  directory: string,
  platform = "linux-x64",
  options: ExtractReleaseOptions = {},
): Promise<ExtractReleaseResult> {
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
  const output = NodePath.join(directory, `graph-${version}-${platform}`);
  let downloadedBinary = false;
  let createdOutput = false;
  try {
    let existing: NodeFS.Stats | undefined;
    try {
      existing = await NodeFSP.stat(binary);
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error;
    }
    if (!existing) {
      await downloadBinary(
        `${releaseBase}/${version}/${platform}/${artifact.binary}`,
        binary,
        version,
        platform,
        artifact.size,
        artifact.checksum,
      );
      downloadedBinary = true;
    }
    const binaryBytes = (await NodeFSP.stat(binary)).size;
    const actualHash = await binaryHash(binary);
    if (binaryBytes !== artifact.size || actualHash !== artifact.checksum) {
      throw new Error(`Official release checksum mismatch: ${version}/${platform}`);
    }
    process.stdout.write(
      `${JSON.stringify({
        event: "official-release-verified",
        version,
        platform,
        artifactKind: "raw-executable",
        downloadBytes: binaryBytes,
        sha256: actualHash,
      })}\n`,
    );
    logDiskUsage("before-extraction", directory, version);

    const result = await extract(
      binary,
      output,
      options.materialize === undefined ? {} : { materialize: options.materialize },
    );
    createdOutput = true;
    await NodeFSP.writeFile(
      NodePath.join(output, ".bun-data/release.json"),
      `${JSON.stringify(
        {
          version,
          platform,
          source: `${releaseBase}/${version}/${platform}/${artifact.binary}`,
          manifest,
        },
        null,
        2,
      )}\n`,
    );
    if (options.discardDownloadedBinary && downloadedBinary) {
      await NodeFSP.rm(binary, { force: true });
    }
    const moduleRegionBytes = result.modules.reduce(
      (total, module) =>
        total + Object.values(module.artifacts).reduce((regions, item) => regions + item.bytes, 0),
      0,
    );
    return {
      directory: output,
      downloadBytes: binaryBytes,
      binarySha256: actualHash,
      serializedGraphBytes: result.serializedGraph.bytes,
      moduleRegionBytes,
      materializedPayloadBytes:
        options.materialize === false ? 0 : result.serializedGraph.bytes + moduleRegionBytes,
      retainedReleaseBytes: await directoryBytes(output),
    };
  } catch (error) {
    const ownedPaths = [
      ...(createdOutput ? [output] : []),
      ...(options.discardDownloadedBinary && downloadedBinary ? [binary] : []),
    ];
    const cleanupFailures = await removeOwned(ownedPaths);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Release extraction failed and owned-output cleanup was incomplete.",
      );
    }
    throw error;
  }
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
