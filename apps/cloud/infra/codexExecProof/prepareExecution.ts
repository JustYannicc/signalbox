// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - fixture preparation transpiles source and copies pinned static modules outside the Worker.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

const RIPGREP_SHA256 = "9205b5dc7fb83d65cacc8f0ded8388d7c4a85baed6367689152307e818497a72";

export async function prepareCodexExecExecutionProof(destination: string, ripgrep: string) {
  const root = NodeURL.fileURLToPath(new URL("../../src/kernel/", import.meta.url));
  const pending = ["CodexExecExecutionProof.ts", "FacetSqliteStorage.ts"];
  const visited = new Set<string>();
  const modules: Record<string, { path: string; type: "js" | "wasm" }> = {};
  await NodeFSP.mkdir(destination, { recursive: true });
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    if (path.startsWith("..") || !path.endsWith(".ts"))
      throw new Error("Invalid fixture module path");
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
  const rg = await NodeFSP.readFile(ripgrep);
  if (NodeCrypto.createHash("sha256").update(rg).digest("hex") !== RIPGREP_SHA256)
    throw new Error("Ripgrep artifact does not match its pin");
  await NodeFSP.writeFile(NodePath.join(destination, "rg.wasm"), rg);
  modules["rg.wasm"] = { path: "rg.wasm", type: "wasm" };
  const main = `import { DurableObject } from 'cloudflare:workers';
import rg from './rg.wasm';
import { createFacetSqliteStorage } from './FacetSqliteStorage.js';
import { runCodexExecExecutionProof } from './CodexExecExecutionProof.js';
export class CodexExecExecutionProofFacet extends DurableObject {
  async fetch() {
    try {
      const storage = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n);
      return Response.json(await runCodexExecExecutionProof(storage, rg, this.ctx));
    } catch (error) { return Response.json({ok:false,error:String(error)}); }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  modules["main.js"] = { path: "main.js", type: "js" };
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "codex-exec-execution-v1",
        mainModule: "main.js",
        entrypoint: "CodexExecExecutionProofFacet",
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
  const [destination, ripgrep] = process.argv.slice(2);
  if (!destination || !ripgrep)
    throw new Error("Pass a fixture directory and pinned ripgrep wasm path");
  await prepareCodexExecExecutionProof(NodePath.resolve(destination), NodePath.resolve(ripgrep));
}
