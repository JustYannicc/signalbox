import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const NPM_REGISTRY = "https://registry.npmjs.org";
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;

export interface NpmArchiveRequest {
  readonly integrity: string;
  readonly resolved: string;
}

export interface DownloadedNpmArchive {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function registryTarball(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLAUDE_SDK_DEPENDENCY_TARBALL_INVALID");
  }
  if (url.origin !== NPM_REGISTRY || url.username || url.password || url.search || url.hash)
    throw new Error("CLAUDE_SDK_DEPENDENCY_REGISTRY_REQUIRED");
  return url.toString();
}

async function readBounded(response: Response) {
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_TARBALL_BYTES)
    throw new Error("CLAUDE_SDK_DEPENDENCY_TARBALL_TOO_LARGE");
  if (!response.body) throw new Error("CLAUDE_SDK_DEPENDENCY_TARBALL_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TARBALL_BYTES) {
        await reader.cancel();
        throw new Error("CLAUDE_SDK_DEPENDENCY_TARBALL_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) throw new Error("CLAUDE_SDK_DEPENDENCY_TARBALL_EMPTY");
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
}

async function mapLimit<A, B>(
  items: ReadonlyArray<A>,
  concurrency: number,
  work: (item: A, index: number) => Promise<B>,
) {
  const results = new Map<number, B>();
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results.set(index, await work(items[index]!, index));
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return items.map((_, index) => results.get(index)!);
}

/** Re-fetch each exact lockfile archive from npm and verify its SRI before use. */
export async function downloadNpmArchives(
  requests: ReadonlyArray<NpmArchiveRequest>,
  directory: string,
): Promise<ReadonlyMap<string, DownloadedNpmArchive>> {
  await NodeFSP.mkdir(directory, { recursive: true });
  const unique = new Map<string, NpmArchiveRequest>();
  for (const request of requests) {
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(request.integrity))
      throw new Error("CLAUDE_SDK_DEPENDENCY_INTEGRITY_INVALID");
    if (Buffer.from(request.integrity.slice(7), "base64").byteLength !== 64)
      throw new Error("CLAUDE_SDK_DEPENDENCY_INTEGRITY_INVALID");
    const resolved = registryTarball(request.resolved);
    const existing = unique.get(request.integrity);
    if (existing && registryTarball(existing.resolved) !== resolved)
      throw new Error("CLAUDE_SDK_DEPENDENCY_PIN_CONFLICT");
    unique.set(request.integrity, { ...request, resolved });
  }

  const entries = [...unique.values()];
  const downloaded = await mapLimit(entries, 2, async (entry, index) => {
    let response: Response;
    try {
      response = await fetch(entry.resolved, { signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new Error("CLAUDE_SDK_DEPENDENCY_DOWNLOAD_FAILED");
    }
    if (!response.ok || registryTarball(response.url) !== entry.resolved)
      throw new Error("CLAUDE_SDK_DEPENDENCY_DOWNLOAD_FAILED");
    const bytes = await readBounded(response);
    const actualIntegrity = `sha512-${NodeCrypto.createHash("sha512")
      .update(bytes)
      .digest("base64")}`;
    if (actualIntegrity !== entry.integrity)
      throw new Error("CLAUDE_SDK_DEPENDENCY_INTEGRITY_MISMATCH");
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    const path = NodePath.join(directory, `${String(index).padStart(4, "0")}.tgz`);
    await NodeFSP.writeFile(path, bytes, { flag: "wx" });
    return { path, sha256, bytes: bytes.byteLength };
  });
  return new Map(entries.map((entry, index) => [entry.integrity, downloaded[index]!] as const));
}
