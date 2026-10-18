// @effect-diagnostics nodeBuiltinImport:off - prepares modules for the persistence proof runner.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type {
  readFilePersistenceProof,
  runFilePersistenceProof,
} from "../../src/kernel/FilePersistenceProof.ts";

export type FilePersistenceProofResult =
  | Awaited<ReturnType<typeof runFilePersistenceProof>>
  | ReturnType<typeof readFilePersistenceProof>;

export const prepareFilePersistenceProof = async (destination: string) => {
  await NodeFSP.mkdir(destination, { recursive: true });
  const modules: Record<string, { path: string; type: "js" }> = {};
  for (const name of [
    "FilePersistenceProof",
    "FacetFilePersistence",
    "FilePersistencePorts",
    "MemoryFilePersistencePorts",
    "FacetSqliteStorage",
    "KernelAbi",
    "KernelWakeRegistry",
    "sqlite/SqliteDatabase",
    "sqlite/SqliteFileSystem",
    "sqlite/SqliteHydration",
    "sqlite/SqliteInodes",
    "sqlite/SqliteChunks",
    "sqlite/SqliteCommitSnapshot",
  ]) {
    const source = await NodeFSP.readFile(
      new URL(`../../src/kernel/${name}.ts`, import.meta.url),
      "utf8",
    );
    const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" }).replaceAll(
      /(from "\.[^"]+)\.ts"/g,
      '$1.js"',
    );
    const path = `${name}.js`;
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(destination, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(destination, path), js);
    modules[path] = { path, type: "js" };
  }

  const main = `import { DurableObject } from 'cloudflare:workers';
import { readFilePersistenceProof, runFilePersistenceProof } from './FilePersistenceProof.js';
export class KernelFilePersistenceFacet extends DurableObject {
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/proof') return Response.json(await runFilePersistenceProof(this.ctx.storage));
      if (path === '/read') return Response.json(readFilePersistenceProof(this.ctx.storage));
      return Response.json({ok:false,error:'Unknown proof path'}, {status:404});
    }
    catch (error) { return Response.json({ok:false,error:String(error)}); }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  modules["main.js"] = { path: "main.js", type: "js" };
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "kernel-file-persistence-v1",
        mainModule: "main.js",
        entrypoint: "KernelFilePersistenceFacet",
        mode: "facet",
        modules,
        paths: ["/proof", "/read"],
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareFilePersistenceProof(NodePath.resolve(destination));
}
