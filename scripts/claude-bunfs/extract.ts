// @effect-diagnostics nodeBuiltinImport:off - build-time extraction from official release artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { readBunGraph, regionNames } from "./bun-graph.ts";
import { cachedReader } from "./range-reader.ts";

export async function extract(binary: string, output: string) {
  const file = await NodeFSP.open(binary, "r");
  const stage = `${output}.partial-${process.pid}`;
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
    await NodeFSP.mkdir(stage, { recursive: false });
    const modules = [];
    const paths = new Set<string>();
    for (const module of graph.modules) {
      const relative = module.name
        .replace(/^.*?\/(?:\$bunfs|~BUN)\/root\//, "")
        .replace(/^B:[\\/]~BUN[\\/]root[\\/]/, "")
        .replaceAll("\\", "/");
      if (
        !relative ||
        relative.startsWith("/") ||
        relative.includes(":") ||
        relative.split("/").some((p) => p === ".." || p === "." || !p) ||
        relative === "manifest.json" ||
        relative.startsWith(".bun-data/") ||
        paths.has(relative)
      )
        throw new Error(`Unsafe or colliding module path: ${module.name}`);
      paths.add(relative);
      const artifacts: Record<string, { path: string; bytes: number; sha256: string }> = {};
      for (const kind of regionNames.slice(1)) {
        const region = module.regions[kind];
        if (!region || (kind !== "contents" && !region.length)) continue;
        const bytes = await reader.read(graph.offset + region.offset, region.length);
        const path = kind === "contents" ? relative : `.bun-data/${module.index}.${kind}`;
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(stage, path)), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(stage, path), bytes, { flag: "wx" });
        artifacts[kind] = {
          path,
          bytes: bytes.length,
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        };
      }
      modules.push({ ...module, artifacts });
    }
    const manifest = {
      schemaVersion: 1,
      binary: { bytes: size, sha256: binaryHash.digest("hex") },
      graph: {
        container: graph.container,
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
    await NodeFSP.rename(stage, output);
    return manifest;
  } catch (error) {
    await NodeFSP.rm(stage, { recursive: true, force: true });
    throw error;
  } finally {
    await file.close();
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
