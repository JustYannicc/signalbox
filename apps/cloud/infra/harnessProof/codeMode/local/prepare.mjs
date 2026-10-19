import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";

const dir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const root = NodePath.resolve(dir, "../../../../../..");
const cloudRoot = NodePath.join(root, "apps/cloud");
export const require = NodeModule.createRequire(NodePath.join(cloudRoot, "package.json"));
export const sha = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export const canonical = (value) => JSON.stringify(value);
const acceptedCandidate = "26fe43086901095106f293245d71f0558a628449767ee276d6d00600eb037876";
const fixtureNames = [
  "exchange.ts",
  "prepare.mjs",
  "proof.ts",
  "run.mjs",
  "tsconfig.json",
  "wrangler.jsonc",
];
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export async function pin(file, path) {
  const bytes = await NodeFSP.readFile(file);
  return { path, bytes: bytes.length, sha256: sha(bytes) };
}

export function inside(parent, file) {
  const relative = NodePath.relative(parent, file);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
}

export async function verifyPins(base, entries) {
  for (const entry of entries) {
    const file = NodePath.resolve(base, entry.path);
    if (!inside(base, file)) throw new Error("Pin escapes its root: " + entry.path);
    const actual = await pin(file, entry.path);
    if (canonical(actual) !== canonical(entry))
      throw new Error("Frozen dependency drift: " + entry.path);
  }
}

async function packageRoot(resolver, name) {
  try {
    return NodePath.dirname(resolver.resolve(name + "/package.json"));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    // Native tool packages can expose only binary subpaths and no main export.
    for (const search of resolver.resolve.paths(name) ?? []) {
      const manifestPath = NodePath.join(search, name, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
      } catch (failure) {
        if (failure.code === "ENOENT") continue;
        throw failure;
      }
      if (manifest.name !== name)
        throw new Error("Tool package identity mismatch: " + name, { cause: error });
      return NodePath.dirname(manifestPath);
    }
    throw error;
  }
}

// Resolve installed tools afresh so a moved checkout needs no saved store paths.
export async function snapshotTools() {
  for (const name of ["ESBUILD_BINARY_PATH", "WRANGLER_WORKERD_PATH", "MINIFLARE_WORKERD_PATH"])
    if (NodeProcess.env[name]) throw new Error("Unpinned tool override: " + name);
  const locations = [];
  const seen = new Set();
  const packages = [];
  const files = [];
  async function visit(resolver, name, from, optional = false) {
    let location;
    try {
      location = await NodeFSP.realpath(await packageRoot(resolver, name));
    } catch (error) {
      if (optional && error.code === "MODULE_NOT_FOUND") return;
      throw error;
    }
    if (seen.has(location)) return;
    const id = "package-" + packages.length;
    seen.add(location);
    const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(location, "package.json")));
    packages.push({ id, name, version: manifest.version, from });
    locations.push({ id, location });
    async function walk(relative = "") {
      const entries = (
        await NodeFSP.readdir(NodePath.join(location, relative), { withFileTypes: true })
      ).sort((a, b) => compare(a.name, b.name));
      for (const entry of entries) {
        if (entry.name === "node_modules") continue;
        const child = NodePath.join(relative, entry.name);
        const absolute = NodePath.join(location, child);
        const stat = await NodeFSP.stat(absolute);
        if (stat.isDirectory()) {
          if (entry.isSymbolicLink())
            throw new Error("Linked tool subdirectory: " + name + "/" + child);
          await walk(child);
        } else if (stat.isFile()) files.push({ package: id, ...(await pin(absolute, child)) });
        else throw new Error("Unsupported tool file: " + name + "/" + child);
      }
    }
    await walk();
    const childRequire = NodeModule.createRequire(NodePath.join(location, "package.json"));
    const optionalDependencies = manifest.optionalDependencies ?? {};
    const dependencies = { ...manifest.dependencies, ...optionalDependencies };
    for (const dependency of Object.keys(dependencies).sort(compare))
      await visit(childRequire, dependency, id, dependency in optionalDependencies);
  }
  for (const name of ["acorn", "esbuild", "wrangler"]) await visit(require, name, null);
  return {
    locations,
    pins: {
      node: {
        version: NodeProcess.version,
        platform: NodeProcess.platform,
        arch: NodeProcess.arch,
        execArgv: NodeProcess.execArgv,
        nodeOptions: NodeProcess.env.NODE_OPTIONS ?? null,
        ...(await pin(NodeProcess.execPath, "node")),
      },
      packages,
      files,
    },
  };
}

export function candidateInputs(frozen) {
  const {
    sourceCandidate,
    sourceAdmission,
    sourcePins,
    files,
    dependencies,
    artifacts,
    compilerMetadata,
    tools,
  } = frozen;
  return {
    sourceCandidate,
    sourceAdmission,
    sourcePins,
    files,
    dependencies,
    artifacts,
    compilerMetadata,
    tools,
  };
}

async function prepare() {
  const [outputFlag, outputArg, sourceFlag, sourceArg, ...extra] = NodeProcess.argv.slice(2);
  if (
    outputFlag !== "--output" ||
    !outputArg ||
    sourceFlag !== "--source-pins" ||
    !sourceArg ||
    extra.length
  )
    throw new Error(
      "node prepare.mjs --output <fresh-directory> --source-pins <accepted-29-file-pins.json>",
    );
  const requested = NodePath.resolve(outputArg);
  const output = NodePath.join(
    await NodeFSP.realpath(NodePath.dirname(requested)),
    NodePath.basename(requested),
  );
  if (inside(await NodeFSP.realpath(root), output))
    throw new Error("Generated proof output must be outside the checkout");
  const sourceBytes = await NodeFSP.readFile(NodePath.resolve(sourceArg));
  const supplied = JSON.parse(sourceBytes);
  if (!Array.isArray(supplied)) throw new Error("Source pins must be an array");
  const sourcePins = supplied
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort((a, b) => compare(a.path, b.path));
  const sourceCandidate = sha(canonical(sourcePins));
  if (sourcePins.length !== 29 || sourceCandidate !== acceptedCandidate)
    throw new Error("Unaccepted CodeMode source candidate");
  await verifyPins(root, sourcePins);
  const files = await Promise.all(
    fixtureNames.map((name) =>
      pin(NodePath.join(dir, name), NodePath.relative(root, NodePath.join(dir, name))),
    ),
  );
  const compilerMetadata = await Promise.all(
    [
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.base.json",
      "knip.ts",
      "apps/cloud/package.json",
      "apps/cloud/tsconfig.json",
    ].map((name) => pin(NodePath.join(root, name), name)),
  );
  const toolsBefore = await snapshotTools();
  await NodeFSP.mkdir(output);
  const save = (name, value) =>
    NodeFSP.writeFile(NodePath.join(output, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
  const { prepareCodeModeHost } = await import(
    NodeURL.pathToFileURL(NodePath.join(cloudRoot, "infra/harnessProof/codeMode/prepare.ts"))
  );
  const prepared = await prepareCodeModeHost({ cloudRoot });
  await save("cell-code.json", prepared.code);
  await save("executable.json", { ...prepared.executable, bytes: [...prepared.executable.bytes] });
  await save("program-inventory.json", prepared.inventory);
  const proofPath = NodePath.join(dir, "proof.ts");
  const { build } = require("esbuild");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [proofPath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    external: ["cloudflare:workers", "node:*"],
    write: false,
    metafile: true,
    nodePaths: [NodePath.join(cloudRoot, "node_modules")],
    plugins: [
      {
        name: "code-mode-artifacts",
        setup(builder) {
          builder.onResolve({ filter: /^\.\/(cell-code|executable)\.json$/ }, (args) => {
            if (args.importer === proofPath)
              return { path: NodePath.basename(args.path), namespace: "code-mode-artifact" };
          });
          builder.onLoad({ filter: /.*/, namespace: "code-mode-artifact" }, async (args) => ({
            contents: await NodeFSP.readFile(NodePath.join(output, args.path), "utf8"),
            loader: "json",
          }));
        },
      },
    ],
  });
  await NodeFSP.writeFile(NodePath.join(output, "worker.js"), result.outputFiles[0].contents, {
    flag: "wx",
  });
  const dependencies = new Map();
  async function identify(input) {
    if (input.startsWith("code-mode-artifact:"))
      return "@output/" + input.slice("code-mode-artifact:".length);
    const absolute = NodePath.resolve(root, input);
    const real = await NodeFSP.realpath(absolute);
    const tool = toolsBefore.locations.find(({ location }) => inside(location, real));
    if (tool) return "@tool/" + tool.id + "/" + NodePath.relative(tool.location, real);
    if (!inside(root, absolute))
      throw new Error("Unpinned bundle input outside checkout: " + input);
    const name = NodePath.relative(root, absolute);
    dependencies.set(name, await pin(absolute, name));
    return name;
  }
  const names = new Map();
  for (const input of Object.keys(result.metafile.inputs).sort(compare))
    names.set(input, await identify(input));
  for (const entry of prepared.inventory.sources)
    await identify(NodePath.join("apps/cloud", entry.path));
  const rename = (name) => names.get(name) ?? name;
  const metafile = {
    inputs: Object.fromEntries(
      [...names].map(([name, mapped]) => [
        mapped,
        {
          ...result.metafile.inputs[name],
          imports: result.metafile.inputs[name].imports.map((row) => ({
            ...row,
            path: rename(row.path),
          })),
        },
      ]),
    ),
    outputs: Object.fromEntries(
      Object.entries(result.metafile.outputs).map(([name, value]) => [
        name,
        {
          ...value,
          entryPoint: rename(value.entryPoint),
          inputs: Object.fromEntries(
            Object.entries(value.inputs).map(([key, data]) => [rename(key), data]),
          ),
        },
      ]),
    ),
  };
  await save("metafile.json", metafile);
  await NodeFSP.copyFile(
    NodePath.join(dir, "wrangler.jsonc"),
    NodePath.join(output, "wrangler.jsonc"),
    NodeFSP.constants.COPYFILE_EXCL,
  );
  await save("tsconfig.json", {
    extends: NodePath.relative(output, NodePath.join(dir, "tsconfig.json")),
    compilerOptions: {
      rootDirs: [NodePath.relative(output, dir), "."],
      types: [
        NodePath.relative(
          output,
          NodePath.join(cloudRoot, "node_modules/@cloudflare/workers-types/index.d.ts"),
        ),
        NodePath.relative(output, NodePath.join(root, "node_modules/@types/node")),
      ],
    },
  });
  const artifacts = await Promise.all(
    [
      "cell-code.json",
      "executable.json",
      "program-inventory.json",
      "worker.js",
      "metafile.json",
      "wrangler.jsonc",
      "tsconfig.json",
    ].map((name) => pin(NodePath.join(output, name), name)),
  );
  const frozen = {
    format: "signalbox-code-mode-local-portable-v1",
    kind: "actual-production-CodeMode-registered-kernel-process-proof",
    sourceCandidate,
    sourceAdmission: { bytes: sourceBytes.length, sha256: sha(sourceBytes) },
    sourcePins,
    files,
    dependencies: [...dependencies.values()].sort((a, b) => compare(a.path, b.path)),
    artifacts,
    compilerMetadata,
    tools: toolsBefore.pins,
    limits: [
      "No official Codex CLI turn or official-host parity",
      "No deployed, CPU refill, OOM, busy-loop preemption or physical-stop qualification",
      "Kernel executable seed/readback, process V1 framing and real WorkerLoader cells only",
    ],
  };
  await verifyPins(root, [...sourcePins, ...files, ...frozen.dependencies, ...compilerMetadata]);
  if (canonical((await snapshotTools()).pins) !== canonical(toolsBefore.pins))
    throw new Error("Tool drift during preparation");
  frozen.candidateSha256 = sha(canonical(candidateInputs(frozen)));
  await save("fixture-freeze.json", frozen);
  console.log(
    JSON.stringify({
      prepared: true,
      sourceFiles: sourcePins.length,
      candidateSha256: frozen.candidateSha256,
      freezeSha256: sha(await NodeFSP.readFile(NodePath.join(output, "fixture-freeze.json"))),
      output,
    }),
  );
}

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
)
  await prepare();
