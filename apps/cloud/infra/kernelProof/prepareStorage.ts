// @effect-diagnostics nodeBuiltinImport:off - prepares modules for #1057's shared proof runner.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const prepareStorageProof = async (destination: string) => {
  await NodeFSP.mkdir(destination, { recursive: true });
  const modules: Record<string, { path: string; type: "js" }> = {};
  for (const name of [
    "FacetSqliteStorage",
    "StorageProof",
    "sqlite/SqliteDatabase",
    "sqlite/SqliteInodes",
    "sqlite/SqliteChunks",
    "sqlite/SqliteFileSystem",
    "sqlite/SqliteHydration",
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
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import { DurableObject } from 'cloudflare:workers';
import { createFacetSqliteStorage } from './FacetSqliteStorage.js';
import { runStorageProof, readStoragePersistence } from './StorageProof.js';
export class KernelStorageFacet extends DurableObject {
  async fetch(request) {
    try {
      const fs = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n);
      return Response.json(new URL(request.url).pathname === '/write' ? runStorageProof(fs) : readStoragePersistence(fs));
    }
    catch (error) { return Response.json({ok:false,error:String(error)}); }
  }
}`,
  );
  modules["main.js"] = { path: "main.js", type: "js" };
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "kernel-storage-v1",
        mainModule: "main.js",
        entrypoint: "KernelStorageFacet",
        mode: "facet",
        modules,
        paths: ["/write", "/read"],
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareStorageProof(NodePath.resolve(destination));
}
