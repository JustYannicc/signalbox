// @effect-diagnostics nodeBuiltinImport:off - build-time source generation for a statically imported WASM module.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import { PROBE_SOURCE } from "./facetSource.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

export const prepare = async () => {
  const dir = new URL("./generated/", import.meta.url);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(new URL("runtime.js", dir), PROBE_SOURCE);
  await NodeFSP.writeFile(
    new URL("runtime.d.ts", dir),
    "export declare function probe(request: Request, ctx: DurableObjectState): Promise<Response>;\n",
  );
  await NodeFSP.writeFile(new URL("suspend.wasm", dir), JSPI_WASM);
  await NodeFSP.writeFile(new URL("esm.js", dir), "export const answer = 42;\n");
  // The same prebuilt module graph is uploaded locally and remotely, including the require(ESM) target.
  for (const name of ["worker", "facetSource", "wasmFixture"]) {
    const source = await NodeFSP.readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
    const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" })
      .replaceAll(/(from "\.\/[^"]+)\.ts"/g, '$1.js"')
      .replace('"./generated/runtime.js"', '"./runtime.js"');
    await NodeFSP.writeFile(new URL(`${name}.js`, dir), js);
  }
};

if (process.argv[1] === new URL(import.meta.url).pathname) await prepare();
