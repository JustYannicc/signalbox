// @effect-diagnostics globalFetch:off - the native facet uses the Workers HTTP API without an Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { readBunGraph } from "./bun-graph.ts";
import { httpReader } from "./range-reader.ts";
import type { BinaryReader } from "./bun-container.ts";

type ProofInput = {
  version: string;
  platform: string;
};

const RELEASE_BASE_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const SUPPORTED_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "win32-x64",
  "win32-arm64",
]);
const HASH_CHUNK_BYTES = 1024 * 1024;

function json(status: number, value: unknown) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseInput(value: unknown): ProofInput {
  const input = record(value);
  if (!input || typeof input.version !== "string" || typeof input.platform !== "string") {
    throw new Error("Body must contain string version and platform fields.");
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version)) {
    throw new Error("version must be a strict semver release.");
  }
  if (!SUPPORTED_PLATFORMS.has(input.platform)) {
    throw new Error(`Unsupported Claude Code platform: ${input.platform}`);
  }
  return { version: input.version, platform: input.platform };
}

function binaryUrl({ version, platform }: ProofInput) {
  const executable = platform.startsWith("win32-") ? "claude.exe" : "claude";
  return `${RELEASE_BASE_URL}/${version}/${platform}/${executable}`;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestRegion(reader: BinaryReader, url: string, start: number, bytes: number) {
  // Node's ambient Crypto type omits workerd's streaming extension.
  const runtimeCrypto: typeof crypto & { DigestStream?: typeof DigestStream } = crypto;
  if (!runtimeCrypto.DigestStream) throw new Error("workerd DigestStream is unavailable");
  const stream = new runtimeCrypto.DigestStream("SHA-256");
  const writer = stream.getWriter();
  if (bytes <= HASH_CHUNK_BYTES) {
    await writer.write(await reader.read(start, bytes));
  } else {
    // A request per MiB spends minutes on network latency for the older monoliths.
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${start + bytes - 1}` },
    });
    if (
      response.status !== 206 ||
      response.headers.get("content-range") !==
        `bytes ${start}-${start + bytes - 1}/${reader.size}` ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error(`Invalid streaming graph range: ${response.status}`);
    }
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > bytes) throw new Error("Streaming graph range exceeded its length");
      await writer.write(chunk);
    }
    if (received !== bytes) throw new Error("Short streaming graph range");
  }
  await writer.close();
  return toHex(new Uint8Array(await stream.digest));
}

async function prove(input: ProofInput) {
  const url = binaryUrl(input);
  const reader = await httpReader(url);
  const graph = await readBunGraph(reader);
  const serializedGraphSha256 = await digestRegion(reader, url, graph.offset, graph.length);
  const modules = [];

  // Hash one bounded contents region at a time; the parser and reader never load
  // the complete executable or module graph into memory.
  for (const module of graph.modules) {
    const contents = module.regions.contents;
    if (!contents) throw new Error(`Module ${module.index} has no contents region.`);
    modules.push({
      index: module.index,
      name: module.name,
      key: module.key,
      encoding: module.encoding,
      loader: module.loader,
      format: module.format,
      side: module.side,
      contentsSha256: await digestRegion(
        reader,
        url,
        graph.offset + contents.offset,
        contents.length,
      ),
    });
  }

  return {
    version: input.version,
    platform: input.platform,
    binaryUrl: url,
    binaryBytes: reader.size,
    serializedGraphSha256,
    graph: {
      container: graph.container,
      offsetsSize: graph.offsetsSize,
      offset: graph.offset,
      length: graph.length,
      byteCount: graph.byteCount,
      flags: graph.flags,
      entry: graph.entry,
      recordSize: graph.recordSize,
    },
    modules,
  };
}

export class ProbeFacet extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let input: ProofInput;
    try {
      input = parseInput({
        version: url.searchParams.get("version"),
        platform: url.searchParams.get("platform"),
      });
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : String(error) });
    }
    try {
      return json(200, await prove(input));
    } catch (error) {
      return json(502, {
        error: error instanceof Error ? error.message : String(error),
        version: input.version,
        platform: input.platform,
      });
    }
  }
}
