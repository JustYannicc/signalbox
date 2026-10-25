// @effect-diagnostics nodeBuiltinImport:off - build-time validation and generation for statically imported WASM modules.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as esbuild from "esbuild";

export interface ChildProgramWasmArtifact {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PreparedChildProgramWasmArtifact {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
  readonly moduleName: string;
}

export interface PreparedChildProgramWasmRegistry {
  readonly source: string;
  readonly artifacts: readonly PreparedChildProgramWasmArtifact[];
  readonly modules: readonly PreparedChildProgramWasmArtifact[];
  readonly references: Readonly<Record<string, string>>;
}

export interface ChildProgramWasmInventory {
  readonly format: "signalbox-child-program-wasm-v1";
  readonly artifacts: readonly {
    readonly name: string;
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
}

export async function readChildProgramWasmInventory(path: string | URL | undefined) {
  if (path === undefined || String(path).length === 0) {
    return Object.freeze({ inventorySha256: undefined, artifacts: Object.freeze([]) });
  }

  const file = path instanceof URL ? NodeURL.fileURLToPath(path) : NodePath.resolve(path);
  const inventoryBytes = await NodeFSP.readFile(file);
  const inventorySha256 = NodeCrypto.createHash("sha256").update(inventoryBytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(inventoryBytes.toString("utf8"));
  } catch (cause) {
    throw new Error(`Invalid child WASM inventory JSON: ${file}`, { cause });
  }
  if (
    !isRecord(value) ||
    value.format !== "signalbox-child-program-wasm-v1" ||
    !Array.isArray(value.artifacts)
  ) {
    throw new TypeError(`Invalid child WASM inventory: ${file}`);
  }

  const root = await NodeFSP.realpath(NodePath.dirname(file));
  const artifacts: ChildProgramWasmArtifact[] = [];
  for (const entry of value.artifacts) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 4 ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.byteLength !== "number" ||
      !Number.isSafeInteger(entry.byteLength) ||
      typeof entry.sha256 !== "string"
    ) {
      throw new TypeError(`Invalid child WASM inventory entry in ${file}`);
    }
    if (!entry.path || NodePath.isAbsolute(entry.path) || NodePath.win32.isAbsolute(entry.path)) {
      throw new TypeError(`Child WASM inventory path must be relative: ${entry.path}`);
    }
    const artifactPath = await NodeFSP.realpath(NodePath.resolve(root, entry.path));
    const relative = NodePath.relative(root, artifactPath);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    ) {
      throw new TypeError(`Child WASM inventory path escapes its directory: ${entry.path}`);
    }
    const bytes = new Uint8Array(await NodeFSP.readFile(artifactPath));
    artifacts.push({
      name: entry.name,
      bytes,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    });
  }

  const prepared = prepareChildProgramWasmRegistry(artifacts);
  return Object.freeze({ inventorySha256, artifacts: prepared.artifacts });
}

/** Validate every input before prepare writes anything into the public module directory. */
export function prepareChildProgramWasmRegistry(
  artifacts: readonly ChildProgramWasmArtifact[] = [],
): PreparedChildProgramWasmRegistry {
  const names = new Set<string>();
  const hashes = new Map<string, PreparedChildProgramWasmArtifact>();
  const references: Record<string, string> = {};
  const preparedArtifacts: PreparedChildProgramWasmArtifact[] = [];

  for (const artifact of artifacts) {
    if (
      !/^[A-Za-z0-9._-]+\.wasm$/.test(artifact.name) ||
      names.has(artifact.name) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0 ||
      !(artifact.bytes instanceof Uint8Array) ||
      artifact.bytes.byteLength !== artifact.byteLength
    ) {
      throw new TypeError(`Invalid child WASM artifact: ${artifact.name}`);
    }
    names.add(artifact.name);

    const bytes = new Uint8Array(artifact.bytes);
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) {
      throw new Error(`Child WASM artifact hash mismatch: ${artifact.name}`);
    }
    if (!WebAssembly.validate(bytes)) {
      throw new Error(`Child WASM artifact is invalid: ${artifact.name}`);
    }

    const previous = hashes.get(sha256);
    if (previous) {
      if (
        previous.byteLength !== bytes.byteLength ||
        previous.bytes.some((byte, index) => byte !== bytes[index])
      ) {
        throw new Error(`Conflicting child WASM artifacts share hash ${sha256}`);
      }
      preparedArtifacts.push(Object.freeze({ ...previous, name: artifact.name }));
      references[artifact.name] = sha256;
      continue;
    }

    const moduleName = NodePath.posix.join("wasm", `${sha256}.wasm`);
    const prepared = Object.freeze({
      name: artifact.name,
      bytes,
      byteLength: bytes.byteLength,
      sha256,
      moduleName,
    });
    hashes.set(sha256, prepared);
    preparedArtifacts.push(prepared);
    references[artifact.name] = sha256;
  }

  const imported = [...hashes.values()].sort((left, right) =>
    left.sha256.localeCompare(right.sha256),
  );
  const imports = imported
    .map(
      ({ moduleName }, index) => `import wasm_${index} from ${JSON.stringify(`./${moduleName}`)};`,
    )
    .join("\n");
  const entries = imported
    .map(({ sha256 }, index) => `  [${JSON.stringify(sha256)}, wasm_${index}],`)
    .join("\n");
  const source = [
    imports,
    "",
    "export const CHILD_PROGRAM_WASM_REGISTRY = new Map([",
    entries,
    "]);",
    "",
  ].join("\n");

  return Object.freeze({
    source,
    artifacts: Object.freeze(preparedArtifacts),
    modules: Object.freeze(imported),
    references: Object.freeze(references),
  });
}

export async function bundleChildWorkerDispatch(options: {
  readonly entryPoint: string;
  readonly outputFile: string;
  readonly outputDirectory: string;
  readonly repositoryRoot: string;
  readonly registry: PreparedChildProgramWasmRegistry;
}) {
  const moduleSpecifiers = options.registry.modules.map((artifact) => `./${artifact.moduleName}`);
  const expectedImports = new Set(["cloudflare:workers", ...moduleSpecifiers]);
  const result = await esbuild.build({
    absWorkingDir: options.repositoryRoot,
    entryPoints: [options.entryPoint],
    outfile: options.outputFile,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    legalComments: "none",
    metafile: true,
    write: false,
    external: [...expectedImports],
    plugins: [
      {
        name: "prepared-child-program-wasm-registry",
        setup(build) {
          build.onResolve({ filter: /^\.\/programWasmRegistry\.ts$/ }, () => ({
            path: "prepared-registry",
            namespace: "prepared-child-program-wasm-registry",
          }));
          build.onLoad({ filter: /.*/, namespace: "prepared-child-program-wasm-registry" }, () => ({
            contents: options.registry.source,
            loader: "js",
            resolveDir: options.outputDirectory,
          }));
        },
      },
    ],
  });

  const output = result.outputFiles.find(
    (file) => NodePath.resolve(file.path) === options.outputFile,
  );
  if (!output) throw new Error("esbuild did not emit the child worker dispatcher");
  const metadata = Object.values(result.metafile.outputs).find(
    (candidate) =>
      candidate.entryPoint !== undefined &&
      NodePath.resolve(options.repositoryRoot, candidate.entryPoint) === options.entryPoint,
  );
  if (!metadata) throw new Error("esbuild did not report the child worker dispatcher graph");
  const emittedImports = metadata.imports.map(({ path: specifier, external }) => ({
    specifier,
    external,
  }));
  if (
    emittedImports.some(
      ({ specifier, external }) => !external || !expectedImports.has(specifier),
    ) ||
    [...expectedImports].some(
      (specifier) => !emittedImports.some((item) => item.specifier === specifier),
    )
  ) {
    throw new Error(
      `Unexpected child worker dispatcher imports: ${JSON.stringify(emittedImports)}`,
    );
  }

  return Object.freeze({
    bytes: new Uint8Array(output.contents),
    imports: Object.freeze(emittedImports),
    sourceInventory: Object.freeze(
      Object.keys(result.metafile.inputs)
        .sort()
        .map((path) => ({ path, bytes: result.metafile.inputs[path]!.bytes })),
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
