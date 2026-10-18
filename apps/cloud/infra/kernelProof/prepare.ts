// @effect-diagnostics nodeBuiltinImport:off - build-time fixture preparation, outside the Worker runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

export const prepareKernelProof = async (destination: string) => {
  await NodeFSP.mkdir(destination, { recursive: true });
  const modules: Record<string, { path: string; type: "js" }> = {};
  for (const name of ["KernelAbi", "KernelWakeRegistry", "KernelAbiProof"]) {
    const source = await NodeFSP.readFile(
      new URL(`../../src/kernel/${name}.ts`, import.meta.url),
      "utf8",
    );
    const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" }).replaceAll(
      /(from "\.[^"]+)\.ts"/g,
      '$1.js"',
    );
    const path = `${name}.js`;
    await NodeFSP.writeFile(NodePath.join(destination, path), js);
    modules[path] = { path, type: "js" };
  }
  const main = `import { DurableObject } from 'cloudflare:workers';
import { runKernelAbiProof } from './KernelAbiProof.js';
export class KernelProofFacet extends DurableObject {
  async fetch() {
    try { return Response.json(await runKernelAbiProof()); }
    catch (error) { return Response.json({ok:false,error:String(error)}); }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  modules["main.js"] = { path: "main.js", type: "js" };
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "kernel-abi-v1",
        mainModule: "main.js",
        entrypoint: "KernelProofFacet",
        mode: "facet",
        modules,
        paths: ["/proof", "/proof-again"],
      },
      null,
      2,
    ),
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareKernelProof(NodePath.resolve(destination));
}
