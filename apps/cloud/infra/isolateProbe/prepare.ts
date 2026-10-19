// @effect-diagnostics nodeBuiltinImport:off - build-time source generation for a statically imported WASM module.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { PROBE_SOURCE } from "./facetSource.ts";
import { JSPI_WASM } from "./wasmFixture.ts";
import {
  bundleChildWorkerDispatch,
  prepareChildProgramWasmRegistry,
  type ChildProgramWasmArtifact,
} from "./programWasmRegistryGeneration.ts";

export interface PrepareOptions {
  readonly generatedDirectory?: string | URL;
  readonly programWasmArtifacts?: readonly ChildProgramWasmArtifact[];
}

export const prepare = async (options: PrepareOptions = {}) => {
  const outputDirectory =
    options.generatedDirectory === undefined
      ? NodeURL.fileURLToPath(new URL("./generated/", import.meta.url))
      : options.generatedDirectory instanceof URL
        ? NodeURL.fileURLToPath(options.generatedDirectory)
        : NodePath.resolve(options.generatedDirectory);
  const dir = NodeURL.pathToFileURL(`${outputDirectory}${NodePath.sep}`);
  // Verify every configured artifact before exposing even the ordinary probe files.
  const registry = prepareChildProgramWasmRegistry(options.programWasmArtifacts);
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  // Old artifact files are still uploaded by prebuilt-worker rules even if the new graph stopped importing them.
  await NodeFSP.rm(NodePath.join(outputDirectory, "wasm"), { recursive: true, force: true });
  await NodeFSP.writeFile(new URL("runtime.js", dir), PROBE_SOURCE);
  await NodeFSP.writeFile(
    new URL("runtime.d.ts", dir),
    "export declare function probe(request: Request, ctx: DurableObjectState): Promise<Response>;\n",
  );
  await NodeFSP.writeFile(new URL("suspend.wasm", dir), JSPI_WASM);
  await NodeFSP.writeFile(new URL("esm.js", dir), "export const answer = 42;\n");
  const childWorkerLimits = await NodeFSP.readFile(
    new URL("../../src/computer/ChildWorkerLimits.ts", import.meta.url),
    "utf8",
  );
  await NodeFSP.writeFile(
    new URL("childWorkerLimits.js", dir),
    NodeModule.stripTypeScriptTypes(childWorkerLimits, { mode: "strip" }),
  );
  // The same prebuilt module graph is uploaded locally and remotely, including the require(ESM) target.
  for (const name of [
    "worker",
    "facetSource",
    "wasmFixture",
    "moduleTransport",
    "moduleUpload",
    "codeGeneration",
    "managedInvocation",
  ]) {
    const source = await NodeFSP.readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
    const js = NodeModule.stripTypeScriptTypes(source, { mode: "strip" })
      .replaceAll(/(from "\.\/[^"]+)\.ts"/g, '$1.js"')
      .replace('"../../src/computer/ChildWorkerLimits.ts"', '"./childWorkerLimits.js"')
      .replace('"./generated/runtime.js"', '"./runtime.js"');
    await NodeFSP.writeFile(new URL(`${name}.js`, dir), js);
  }

  const outputFile = NodePath.join(outputDirectory, "childWorkerDispatch.js");
  const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../../../");
  const dispatch = await bundleChildWorkerDispatch({
    entryPoint: NodeURL.fileURLToPath(new URL("./childWorkerDispatch.ts", import.meta.url)),
    outputFile,
    outputDirectory,
    repositoryRoot,
    registry,
  });
  await NodeFSP.writeFile(outputFile, dispatch.bytes);
  for (const artifact of registry.modules) {
    const modulePath = NodePath.join(outputDirectory, artifact.moduleName);
    await NodeFSP.mkdir(NodePath.dirname(modulePath), { recursive: true });
    await NodeFSP.writeFile(modulePath, artifact.bytes);
  }

  const moduleFiles = await listModules(outputDirectory);
  const modules = await Promise.all(
    moduleFiles.map(async (name) => {
      const bytes = await NodeFSP.readFile(NodePath.join(outputDirectory, name));
      return {
        name,
        type: name.endsWith(".wasm") ? "wasm" : "js",
        byteLength: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  const inventory = {
    format: "signalbox-isolate-probe-module-inventory-v1",
    modules: modules.sort((left, right) => left.name.localeCompare(right.name)),
    programWasm: {
      references: registry.references,
      modules: registry.modules.map(({ name, byteLength, sha256, moduleName }) => ({
        name,
        moduleName,
        byteLength,
        sha256,
        reference: sha256,
      })),
    },
    dispatchImports: dispatch.imports,
    dispatchSources: dispatch.sourceInventory,
  };
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "module-inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );

  return inventory;
};

async function listModules(directory: string, prefix = ""): Promise<string[]> {
  const entries = await NodeFSP.readdir(NodePath.join(directory, prefix), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return listModules(directory, name);
      return /\.(?:js|wasm)$/.test(entry.name) ? [name] : [];
    }),
  );
  return nested.flat().sort();
}

if (process.argv[1] === new URL(import.meta.url).pathname) await prepare();
