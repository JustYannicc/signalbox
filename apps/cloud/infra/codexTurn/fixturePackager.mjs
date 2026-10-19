import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const sha256 = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};

function safeRelative(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    NodePath.isAbsolute(value) ||
    value.includes("\\")
  ) {
    fail(`Unsafe ${label}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "." || part.length === 0))
    fail(`Unsafe ${label}`);
  return value;
}

async function realOrResolved(file) {
  const resolved = NodePath.resolve(file);
  let ancestor = resolved;
  const suffix = [];
  while (true) {
    try {
      const canonical = await NodeFSP.realpath(ancestor);
      return NodePath.join(canonical, ...suffix.toReversed());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = NodePath.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(NodePath.basename(ancestor));
      ancestor = parent;
    }
  }
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}${NodePath.sep}`) || b.startsWith(`${a}${NodePath.sep}`);
}

async function fileBytes(file, label) {
  const info = await NodeFSP.lstat(file).catch(() => fail(`Missing ${label}: ${file}`));
  if (!info.isFile() || info.isSymbolicLink()) fail(`Invalid ${label}: expected a regular file`);
  return NodeFSP.readFile(file);
}

/** Package already-built WASI bytes as an isolateProbe fixture; no compilation or byte rewriting occurs. */
export async function createCodexFixture({
  artifactDir,
  additionalModules = {},
  expectedManifestSha256,
  entryModulePath,
  outputDir,
  paths,
  id,
}) {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? ""))
    fail("Invalid expected manifest SHA-256");
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,82}$/.test(id))
    fail("Unsafe fixture id");
  if (
    !Array.isArray(paths) ||
    paths.some((p) => typeof p !== "string" || !p.startsWith("/") || p.includes(".."))
  )
    fail("Invalid probe paths");

  const artifact = await NodeFSP.realpath(artifactDir);
  const out = await realOrResolved(outputDir);
  const entry = await NodeFSP.realpath(entryModulePath);
  if (overlaps(out, artifact) || overlaps(out, entry)) fail("Output directory overlaps an input");
  const outInfo = await NodeFSP.lstat(out).catch((error) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (outInfo) fail("Output directory already exists");

  const manifestBytes = await fileBytes(
    NodePath.join(artifact, "manifest.json"),
    "artifact manifest",
  );
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256) fail("Artifact manifest SHA-256 mismatch");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("Invalid artifact manifest JSON");
  }
  if (manifest.target !== "wasm32-wasip1") fail(`Unsupported artifact target: ${manifest.target}`);
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.abiVersion !== 1
  )
    fail("Inconsistent artifact version or ABI");
  const files = manifest.files;
  if (!files || typeof files !== "object") fail("Artifact manifest has no files inventory");

  const inputs = {};
  for (const name of ["engine.wasm", "loader.mjs"]) {
    const declared = files[name];
    if (
      !declared ||
      !/^[a-f0-9]{64}$/.test(declared.sha256 ?? "") ||
      !Number.isSafeInteger(declared.bytes)
    )
      fail(`Invalid manifest entry for ${name}`);
    const bytes = await fileBytes(NodePath.join(artifact, name), name);
    if (bytes.byteLength !== declared.bytes || sha256(bytes) !== declared.sha256)
      fail(`${name} does not match artifact manifest`);
    if (name === "engine.wasm" && manifest.moduleSha256 !== declared.sha256)
      fail("moduleSha256 does not match engine.wasm");
    if (name === "engine.wasm" && manifest.moduleBytes !== bytes.byteLength)
      fail("moduleBytes does not match engine.wasm");
    inputs[name] = bytes;
  }

  if (
    !additionalModules ||
    typeof additionalModules !== "object" ||
    Array.isArray(additionalModules)
  )
    fail("Invalid additional modules");
  const declaredAdditionalModules = Object.entries(additionalModules);
  const reservedNames = new Set([
    "worker.js",
    "loader.mjs",
    "engine.wasm",
    "manifest.json",
    "inventory.json",
  ]);
  for (const [name, declared] of declaredAdditionalModules) {
    safeRelative(name, "additional module name");
    if (name.includes("/")) fail(`Additional module name must be flat: ${name}`);
    if (reservedNames.has(name)) fail(`Reserved additional module name: ${name}`);
    if (
      !declared ||
      typeof declared !== "object" ||
      Array.isArray(declared) ||
      typeof declared.path !== "string" ||
      declared.path.length === 0 ||
      declared.type !== "wasm" ||
      !Number.isSafeInteger(declared.bytes) ||
      declared.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(declared.sha256 ?? "")
    )
      fail(`Invalid metadata for additional module ${name}`);
    reservedNames.add(name);
  }
  const additionalModuleBytes = new Map();
  for (const [name, declared] of declaredAdditionalModules) {
    const bytes = await fileBytes(declared.path, `additional module ${name}`);
    if (bytes.byteLength !== declared.bytes || sha256(bytes) !== declared.sha256)
      fail(`Additional module ${name} does not match declared size and SHA-256`);
    additionalModuleBytes.set(name, bytes);
  }

  const entryBytes = await fileBytes(entry, "entry module");
  await NodeFSP.mkdir(out, { recursive: false });
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(out, "engine.wasm"), inputs["engine.wasm"], {
      flag: "wx",
      mode: 0o444,
    }),
    NodeFSP.writeFile(NodePath.join(out, "loader.mjs"), inputs["loader.mjs"], {
      flag: "wx",
      mode: 0o444,
    }),
    NodeFSP.writeFile(NodePath.join(out, "worker.js"), entryBytes, { flag: "wx", mode: 0o444 }),
    ...[...additionalModuleBytes.entries()].map(([name, bytes]) =>
      NodeFSP.writeFile(NodePath.join(out, name), bytes, { flag: "wx", mode: 0o444 }),
    ),
  ]);

  const probeManifest = {
    id,
    mode: "facet",
    mainModule: "worker.js",
    entrypoint: "ProbeFacet",
    modules: {
      "worker.js": { path: "worker.js", type: "js" },
      "loader.mjs": { path: "loader.mjs", type: "js" },
      "engine.wasm": { path: "engine.wasm", type: "wasm" },
      ...Object.fromEntries(
        [...additionalModuleBytes.keys()].map((name) => [name, { path: name, type: "wasm" }]),
      ),
    },
    paths: [...paths],
  };
  const inventory = {
    schemaVersion: 1,
    artifact: {
      target: manifest.target,
      version: manifest.version,
      abiVersion: manifest.abiVersion,
      manifestSha256,
    },
    files: Object.fromEntries(
      [
        ["worker.js", entryBytes],
        ["loader.mjs", inputs["loader.mjs"]],
        ["engine.wasm", inputs["engine.wasm"]],
        ...additionalModuleBytes.entries(),
      ].map(([name, bytes]) => [name, { bytes: bytes.byteLength, sha256: sha256(bytes) }]),
    ),
  };
  await Promise.all([
    NodeFSP.writeFile(
      NodePath.join(out, "manifest.json"),
      `${JSON.stringify(probeManifest, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o444,
      },
    ),
    NodeFSP.writeFile(
      NodePath.join(out, "inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o444,
      },
    ),
  ]);
  return { outputDir: out, manifest: probeManifest, inventory };
}
