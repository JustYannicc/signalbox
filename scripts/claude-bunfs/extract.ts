// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone Node extraction from official release artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { readBunGraph, regionNames } from "./bun-graph.ts";
import { cachedReader } from "./range-reader.ts";

const READ_CHUNK_BYTES = 1024 * 1024;
type FileHandle = Awaited<ReturnType<typeof NodeFSP.open>>;
export type ExtractFileOperations = {
  open(path: string, flags: string): Promise<FileHandle>;
  remove(path: string): Promise<void>;
};

const defaultFileOperations: ExtractFileOperations = {
  open: (path, flags) => NodeFSP.open(path, flags),
  remove: (path) => NodeFSP.rm(path, { recursive: true, force: true }),
};

function withCleanupFailures(primary: unknown, cleanupFailures: readonly unknown[]) {
  const failures = primary instanceof AggregateError ? [...primary.errors] : [primary];
  return new AggregateError(
    [...failures, ...cleanupFailures],
    primary instanceof Error ? primary.message : "Bun extraction failed.",
    { cause: primary },
  );
}

async function withClosedFile<T>(file: FileHandle, operation: () => Promise<T>): Promise<T> {
  let failed = false;
  let primary: unknown;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    try {
      await file.close();
    } catch (closeError) {
      if (failed) throw withCleanupFailures(primary, [closeError]);
      throw closeError;
    }
  }
}

export function modulePath(name: string) {
  const relative = name
    .replace(/^.*?\/(?:\$bunfs|~BUN)\/root\//, "")
    .replace(/^B:[\\/]~BUN[\\/]root[\\/]/, "")
    .replaceAll("\\", "/");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes(":") ||
    relative.split("/").some((p) => p === ".." || p === "." || !p) ||
    relative === "manifest.json" ||
    relative === ".bun-data" ||
    relative.startsWith(".bun-data/")
  )
    throw new Error(`Unsafe module path: ${name}`);
  return relative;
}

export async function extract(
  binary: string,
  output: string,
  {
    materialize = true,
    fileOperations = defaultFileOperations,
  }: { materialize?: boolean; fileOperations?: ExtractFileOperations } = {},
) {
  const file = await fileOperations.open(binary, "r");
  let stage: string | undefined;
  let sourceClosed = false;
  let failed = false;
  let primary: unknown;
  try {
    const size = (await file.stat()).size;
    const reader = cachedReader({
      size,
      async read(offset, length) {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        if (bytesRead !== length) throw new Error("short file read");
        return buffer;
      },
    });
    const graph = await readBunGraph(reader);
    const binaryHash = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(binary)) binaryHash.update(chunk);
    stage = await NodeFSP.mkdtemp(`${output}.partial-`);
    await NodeFSP.mkdir(NodePath.join(stage, ".bun-data"));
    const graphFile = materialize
      ? await fileOperations.open(NodePath.join(stage, ".bun-data/graph.bin"), "wx")
      : undefined;
    const graphHash = NodeCrypto.createHash("sha256");
    const hashGraph = async () => {
      for (let offset = 0; offset < graph.length; offset += READ_CHUNK_BYTES) {
        const bytes = await reader.read(
          graph.offset + offset,
          Math.min(READ_CHUNK_BYTES, graph.length - offset),
        );
        graphHash.update(bytes);
        await graphFile?.writeFile(bytes);
      }
      return graphHash.digest("hex");
    };
    const serializedGraphSha256 = graphFile
      ? await withClosedFile(graphFile, hashGraph)
      : await hashGraph();
    const modules = [];
    const paths = new Set<string>();
    for (const module of graph.modules) {
      const relative = modulePath(module.name);
      if (paths.has(relative)) throw new Error(`Colliding module path: ${module.name}`);
      paths.add(relative);
      const artifacts: Record<string, { path?: string; bytes: number; sha256: string }> = {};
      for (const kind of regionNames.slice(1)) {
        const region = module.regions[kind];
        if (!region || (kind !== "contents" && !region.length)) continue;
        const path = kind === "contents" ? relative : `.bun-data/${module.index}.${kind}`;
        let artifactFile: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
        if (materialize) {
          await NodeFSP.mkdir(NodePath.dirname(NodePath.join(stage, path)), { recursive: true });
          artifactFile = await fileOperations.open(NodePath.join(stage, path), "wx");
        }
        const artifactHash = NodeCrypto.createHash("sha256");
        const hashArtifact = async () => {
          for (let offset = 0; offset < region.length; offset += READ_CHUNK_BYTES) {
            const bytes = await reader.read(
              graph.offset + region.offset + offset,
              Math.min(READ_CHUNK_BYTES, region.length - offset),
            );
            artifactHash.update(bytes);
            await artifactFile?.writeFile(bytes);
          }
          return artifactHash.digest("hex");
        };
        const artifactSha256 = artifactFile
          ? await withClosedFile(artifactFile, hashArtifact)
          : await hashArtifact();
        artifacts[kind] = {
          ...(materialize ? { path } : {}),
          bytes: region.length,
          sha256: artifactSha256,
        };
      }
      modules.push({ ...module, artifacts });
    }
    const manifest = {
      schemaVersion: 1,
      binary: { bytes: size, sha256: binaryHash.digest("hex") },
      serializedGraph: {
        ...(materialize ? { path: ".bun-data/graph.bin" } : {}),
        bytes: graph.length,
        sha256: serializedGraphSha256,
      },
      graph: {
        container: graph.container,
        offsetsSize: graph.offsetsSize,
        offset: graph.offset,
        length: graph.length,
        byteCount: graph.byteCount,
        flags: graph.flags,
        recordSize: graph.recordSize,
        entry: graph.entry,
      },
      modules,
    };
    await NodeFSP.writeFile(
      NodePath.join(stage, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        flag: "wx",
      },
    );
    await file.close();
    sourceClosed = true;
    await NodeFSP.rename(stage, output);
    return manifest;
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    if (failed) {
      const cleanupFailures: unknown[] = [];
      if (stage) {
        try {
          await fileOperations.remove(stage);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (!sourceClosed) {
        try {
          await file.close();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw withCleanupFailures(primary, cleanupFailures);
      }
    } else if (!sourceClosed) {
      await file.close();
    }
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [binary, output] = process.argv.slice(2);
  if (!binary || !output)
    throw new Error("Usage: node scripts/claude-bunfs/extract.ts <binary> <new-output-directory>");
  const result = await extract(binary, output);
  console.log(
    JSON.stringify({ binary: result.binary, graph: result.graph, modules: result.modules.length }),
  );
}
