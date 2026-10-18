// @effect-diagnostics nodeBuiltinImport:off - static Cloudflare facet fixture preparation only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

const COMMANDS = Object.freeze([
  "cat",
  "echo",
  "printf",
  "ls",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "pwd",
  "head",
  "tail",
  "wc",
  "uniq",
] as const);
const SOURCE_MARKER = "__KERNEL_COREUTILS_PROGRAM_FACET_SOURCE_INVENTORY__";
const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const artifactDir = NodePath.join(scriptDir, "bin");
const digest = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

interface SourceRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ProgramRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly imports: ReadonlyArray<unknown>;
}

/** Build a static Cloudflare facet that runs every pinned uutils program. */
export async function prepareKernelCoreutilsProgramsFacet(destination: string) {
  const provenance = JSON.parse(
    await NodeFSP.readFile(NodePath.join(scriptDir, "provenance.json"), "utf8"),
  ) as {
    readonly package: string;
    readonly version: string;
    readonly commands: Record<string, ProgramRecord>;
  };
  const artifacts = await Promise.all(
    COMMANDS.map(async (command) => {
      const record = provenance.commands[command];
      if (!record) throw new Error(`Missing ${command} in coreutils provenance`);
      const bytes = await NodeFSP.readFile(NodePath.join(artifactDir, `${command}.wasm`));
      const sha256 = digest(bytes);
      if (bytes.byteLength !== record.bytes || sha256 !== record.sha256) {
        throw new Error(`${command}.wasm does not match its provenance pin`);
      }
      return { command, bytes, record };
    }),
  );

  const cloudRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const sourcePath = NodePath.join(scriptDir, "facet-program-source.ts");
  const external = [
    "cloudflare:workers",
    "node:*",
    ...COMMANDS.map((command) => `./bin/${command}.wasm`),
  ];
  const build = await Esbuild.build({
    absWorkingDir: cloudRoot,
    stdin: {
      contents: await NodeFSP.readFile(sourcePath, "utf8"),
      resolveDir: scriptDir,
      sourcefile: "kernel-coreutils-program-facet.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external,
  });
  const inputs = Object.keys(build.metafile.inputs)
    .filter((path) => !path.endsWith("kernel-coreutils-program-facet.ts"))
    .sort();
  const sources = await Promise.all(inputs.map((path) => sourceRecord(cloudRoot, path)));
  for (const path of [
    "infra/kernelPrograms/coreutils/facet-program-source.ts",
    "infra/kernelPrograms/coreutils/prepareProgramsFacet.ts",
    "infra/kernelPrograms/coreutils/provenance.json",
    "infra/kernelPrograms/coreutils/import-abi.json",
    "infra/kernelPrograms/coreutils/build-mkdir.sh",
    "infra/kernelPrograms/coreutils/patches/0001-use-proc-umask-on-wasi.patch",
    "infra/kernelPrograms/coreutils/patches/0002-mkdir-wasi-mode.patch",
  ]) {
    sources.push(await sourceRecord(cloudRoot, path));
  }
  sources.sort((left, right) => left.path.localeCompare(right.path));

  const bundled = build.outputFiles[0]?.text;
  if (bundled === undefined || !bundled.includes(JSON.stringify(SOURCE_MARKER))) {
    throw new Error("Coreutils program facet bundle lost its source inventory marker");
  }
  if (/WebAssembly\.Module\s*\(|\beval\s*\(/.test(bundled)) {
    throw new Error("Coreutils program facet must use only statically imported WASM modules");
  }
  const main = bundled.replace(JSON.stringify(SOURCE_MARKER), JSON.stringify(sources));
  const modules = [
    { name: "main.js", type: "js", bytes: Buffer.byteLength(main), sha256: digest(main) },
    ...artifacts.map(({ command, bytes }) => ({
      name: `bin/${command}.wasm`,
      type: "wasm",
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    })),
  ];
  const outputDir = NodePath.resolve(destination);
  await NodeFSP.mkdir(NodePath.join(outputDir, "bin"), { recursive: true });
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "inventory.json"),
      `${JSON.stringify(
        {
          package: `${provenance.package}@${provenance.version}`,
          artifacts: Object.fromEntries(artifacts.map(({ command, record }) => [command, record])),
          sources,
          modules,
        },
        null,
        2,
      )}\n`,
    ),
    NodeFSP.writeFile(
      NodePath.join(outputDir, "manifest.json"),
      `${JSON.stringify(
        {
          id: "kernel-coreutils-programs-v1",
          mainModule: "main.js",
          entrypoint: "KernelCoreutilsProgramFacet",
          mode: "facet",
          allowOutbound: false,
          modules: Object.fromEntries(
            modules.map(({ name, type }) => [name, { path: name, type }]),
          ),
          paths: ["/proof", "/proof-again"],
        },
        null,
        2,
      )}\n`,
    ),
    ...artifacts.map(({ command, bytes }) =>
      NodeFSP.writeFile(NodePath.join(outputDir, "bin", `${command}.wasm`), bytes),
    ),
  ]);
  return { package: `${provenance.package}@${provenance.version}`, sources, modules };
}

async function sourceRecord(root: string, path: string): Promise<SourceRecord> {
  const bytes = await NodeFSP.readFile(NodePath.resolve(root, path));
  return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a facet output directory");
  const inventory = await prepareKernelCoreutilsProgramsFacet(NodePath.resolve(destination));
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}
