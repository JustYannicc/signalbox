// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - module preparation runs in Node before the fixture reaches a Worker.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

export async function prepareCodexExecFileSystemProof(destination: string) {
  const root = NodeURL.fileURLToPath(new URL("../../src/kernel/", import.meta.url));
  const pending = ["CodexExecFileSystemProof.ts", "FacetSqliteStorage.ts"];
  const visited = new Set<string>();
  const modules: Record<string, { path: string; type: "js" }> = {};
  await NodeFSP.mkdir(destination, { recursive: true });

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (path.startsWith("..") || !path.endsWith(".ts"))
      throw new Error("Invalid filesystem proof module path");
    const source = await NodeFSP.readFile(NodePath.join(root, path), "utf8");
    const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" }).replaceAll(
      /(from "\.[^"]+)\.ts"/g,
      '$1.js"',
    );
    for (const match of js.matchAll(/(?:from|import)\s*["'](\.[^"']+)\.js["']/g)) {
      pending.push(NodePath.normalize(NodePath.join(NodePath.dirname(path), `${match[1]}.ts`)));
    }
    const name = path.replace(/\.ts$/, ".js");
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(destination, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(destination, name), js);
    modules[name] = { path: name, type: "js" };
  }

  const main = `import { DurableObject } from 'cloudflare:workers';
import { createFacetSqliteStorage } from './FacetSqliteStorage.js';
import { runCodexExecFileSystemProof } from './CodexExecFileSystemProof.js';
export class CodexExecFileSystemProofFacet extends DurableObject {
  async fetch(request) {
    try {
      const storage = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n);
      const phase = new URL(request.url).pathname === '/proof-again' ? 'persist' : 'write';
      return Response.json(await runCodexExecFileSystemProof(storage, this.ctx, phase));
    } catch (error) { return Response.json({ok:false,error:String(error)}); }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  modules["main.js"] = { path: "main.js", type: "js" };
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "codex-exec-filesystem-v1",
        mainModule: "main.js",
        entrypoint: "CodexExecFileSystemProofFacet",
        mode: "facet",
        modules,
        paths: ["/proof", "/proof-again"],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareCodexExecFileSystemProof(NodePath.resolve(destination));
}
