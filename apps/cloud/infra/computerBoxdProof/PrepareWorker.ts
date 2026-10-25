// @effect-diagnostics nodeBuiltinImport:off - the launcher builds static WASM imports before starting workerd or deploying a Worker.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as esbuild from "esbuild";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { prepareChildProgramWasmRegistry } from "../isolateProbe/programWasmRegistryGeneration.ts";
import type { ProofSeed } from "./SeedProtocol.ts";

const pins = {
  "/bin/bash": { name: "bash.wasm", ...KERNEL_BASH_ARTIFACT },
  "/bin/cat": { name: "busybox.wasm", ...KERNEL_BUSYBOX_ARTIFACT },
  "/bin/rg": { name: "rg.wasm", ...KERNEL_RIPGREP_ARTIFACT },
};

export async function prepareProofWorker(options: {
  readonly seed: ProofSeed;
  readonly outputDirectory: string;
}) {
  if (options.seed.executables.length !== 3) throw new Error("Expected all three proof WASM pins");
  const seen = new Set<string>();
  const artifacts = options.seed.executables.map((file) => {
    const pin = pins[file.path];
    if (!pin || seen.has(file.path) || file.sha256 !== pin.sha256)
      throw new Error("Invalid or duplicate proof WASM pin");
    seen.add(file.path);
    return {
      name: pin.name,
      bytes: new Uint8Array(Buffer.from(file.data, "base64")),
      byteLength: pin.bytes,
      sha256: pin.sha256,
    };
  });
  // Validate every byte before touching a retained bundle that recovery may still need.
  const registry = prepareChildProgramWasmRegistry(artifacts);
  const outputDirectory = NodePath.resolve(options.outputDirectory);
  const entryPoint = NodePath.join(outputDirectory, "worker.js");
  const repositoryRoot = NodePath.resolve(import.meta.dirname, "../../../..");
  const imports = [
    "cloudflare:workers",
    "node:async_hooks",
    "node:fs",
    ...registry.modules.map(({ moduleName }) => `./${moduleName}`),
  ];
  const bundle = await esbuild.build({
    absWorkingDir: repositoryRoot,
    entryPoints: [NodePath.resolve(import.meta.dirname, "worker.ts")],
    outfile: entryPoint,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    legalComments: "none",
    metafile: true,
    write: false,
    external: imports,
    plugins: [
      {
        name: "proof-static-wasm-registry",
        setup(build) {
          build.onResolve({ filter: /^\.\/programWasmRegistry\.ts$/ }, () => ({
            path: "registry",
            namespace: "proof-static-wasm-registry",
          }));
          build.onLoad({ filter: /.*/, namespace: "proof-static-wasm-registry" }, () => ({
            contents: registry.source,
            loader: "js",
            resolveDir: outputDirectory,
          }));
        },
      },
    ],
  });
  const output = bundle.outputFiles.find((file) => NodePath.resolve(file.path) === entryPoint);
  const graph = Object.values(bundle.metafile.outputs).find(
    (file) => file.entryPoint !== undefined,
  );
  if (
    !output ||
    !graph ||
    graph.imports.some((item) => !item.external || !imports.includes(item.path)) ||
    imports.some((specifier) => !graph.imports.some((item) => item.path === specifier))
  )
    throw new Error("Unexpected proof Worker module graph");
  const dispatch = {
    bytes: output.contents,
    imports: graph.imports,
    sourceInventory: Object.entries(bundle.metafile.inputs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, input]) => ({ path, bytes: input.bytes })),
  };
  const inventory = {
    format: "signalbox-computer-boxd-proof-worker-v1",
    sourceCommit: options.seed.sourceCommit,
    modules: [
      {
        name: "worker.js",
        byteLength: dispatch.bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(dispatch.bytes).digest("hex"),
      },
      ...registry.modules.map(({ moduleName, byteLength, sha256 }) => ({
        name: moduleName,
        byteLength,
        sha256,
      })),
    ],
    wasmReferences: registry.references,
    imports: dispatch.imports,
    sources: dispatch.sourceInventory,
  };
  await NodeFSP.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await NodeFSP.rm(NodePath.join(outputDirectory, "wasm"), { recursive: true, force: true });
  for (const artifact of registry.modules) {
    const file = NodePath.join(outputDirectory, artifact.moduleName);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, artifact.bytes);
  }
  await NodeFSP.writeFile(entryPoint, dispatch.bytes);
  await NodeFSP.writeFile(
    NodePath.join(outputDirectory, "module-inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  return { entryPoint, inventory };
}
