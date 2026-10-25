// @effect-diagnostics nodeBuiltinImport:off - packages an isolated facet proof.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";

const ARTIFACT_MARKER = "__RIPGREP_SORT_ARTIFACT__";
const PROOF_SOURCE = String.raw`import { DurableObject } from "cloudflare:workers";
import rg from "./rg.wasm";
import { KernelProgramRegistry } from "./src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "./src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "./src/kernel/KernelProgramHost.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST, createKernelRipgrepProgram } from "./src/kernel/KernelRipgrepProgram.ts";
import { KernelWakeRegistry } from "./src/kernel/KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "./src/kernel/FacetSqliteStorage.ts";
import { createNodeChildProcess } from "./src/isolate/NodeChildProcess.ts";

const artifact = __RIPGREP_SORT_ARTIFACT__;
const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
const glob = ["--files", "--null", "--glob", "*.txt", "--sort=modified", "--no-ignore", "--hidden", "."];
const grep = ["--hidden", "--glob", "!.git", "--glob", "!.svn", "--glob", "!.hg", "--glob", "!.bzr", "--glob", "!.jj", "--glob", "!.sl", "--max-columns", "500", "--json", "-n", "needle-after", "."];
const entries = [["z-old.txt", 1700000000000000000n], ["a-mid.txt", 1700000100000000000n], ["m-new.txt", 1700000200000000000n]];
const creationOrder = [entries[1], entries[2], entries[0]];
const sorted = entries.map(([name]) => "./" + name);
const encoder = new TextEncoder();

export class RipgrepSortFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = createFacetSqliteStorage(ctx.storage, () => 1800000000000000001n);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ripgrep_sort_proof_calls (id INTEGER PRIMARY KEY, calls INTEGER NOT NULL, seed_order TEXT NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO ripgrep_sort_proof_calls VALUES (1, 0, '')");
    try { this.storage.posix.get(this.storage.root); }
    catch (error) {
      if (error?.code !== "ENOTSUP") throw error;
      this.storage.posix.initialize(this.storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
    }
    const root = this.storage.posix.get(this.storage.root);
    if (root.mode !== 0o755 || root.uid !== 1000 || root.gid !== 1000) throw new Error("fixture root metadata changed");
    this.serial = Promise.resolve();
  }

  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/proof" && path !== "/proof-again") return new Response("Not found", { status: 404 });
    const result = this.serial.then(() => this.prove(path));
    this.serial = result.catch(() => {});
    return result;
  }

  async prove(path) {
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE ripgrep_sort_proof_calls SET calls = calls + 1 WHERE id = 1");
    const calls = sql.exec("SELECT calls AS n, seed_order AS seedOrder FROM ripgrep_sort_proof_calls WHERE id = 1").one().n;
    const checks = {}, results = [], filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: this.storage }], posix: { credentials, umask: 0o022 },
    });
    const wakes = new KernelWakeRegistry();
    let host;
    try {
      const created = [ensureDirectory(filesystem, "/work"), ensureDirectory(filesystem, "/outside")];
      const createdFiles = [];
      for (const [name, mtimeNs] of creationOrder) {
        const wasCreated = ensureFile(filesystem, "/work/" + name, "needle-after " + name + "\n", mtimeNs);
        created.push(wasCreated);
        if (wasCreated) createdFiles.push(name);
      }
      if (calls === 1) sql.exec("UPDATE ripgrep_sort_proof_calls SET seed_order = ? WHERE id = 1", JSON.stringify(createdFiles));
      const seedOrder = sql.exec("SELECT seed_order FROM ripgrep_sort_proof_calls WHERE id = 1").one().seed_order;
      checks.callCount = calls === (path === "/proof" ? 1 : 2);
      checks.fixtureCreatedOnlyOnce = calls === 1 ? created.filter(Boolean).length === 5 && JSON.stringify(createdFiles) === JSON.stringify(creationOrder.map(([name]) => name)) : created.every((value) => !value) && createdFiles.length === 0;
      checks.fixtureOrderDiffersFromMtime = JSON.stringify(JSON.parse(seedOrder)) !== JSON.stringify(sorted.map((name) => name.slice(2)));
      const before = snapshot(filesystem);
      filesystem.chdir("/work");
      const directory = filesystem.open("/work", 0x800);
      const cwds = ["/work", "/proc/self/fd/" + directory];
      const registry = new KernelProgramRegistry();
      const registered = registry.register(KERNEL_RIPGREP_PROGRAM_MANIFEST);
      if (registered.status !== "ok") throw new Error("ripgrep registry failed: " + JSON.stringify(registered));
      host = new KernelProgramHost({ registry, wakes, programs: new Map([["/bin/rg", {
        manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST, implementation: createKernelRipgrepProgram({ module: rg }),
      }]]) });
      const child = createNodeChildProcess(host, { filesystem, env: { PATH: "/bin", HOME: "/home/claude", TMPDIR: "/tmp" } });
      const state = { checks, results, child, host, wakes, count: 0 };
      for (const [index, cwd] of cwds.entries()) await runRootCases(state, cwd, index === 0 ? "cwd" : "procfd");
      const pathFilestatGet = 1n << 18n, reduced = [];
      for (const [fd, descriptor] of filesystem.descriptors.entries()) {
        if (descriptor.kind !== "directory") continue;
        const beforeRights = descriptor.rightsBase;
        descriptor.rightsBase &= ~pathFilestatGet;
        reduced.push({ fd, before: beforeRights.toString(), after: descriptor.rightsBase.toString() });
      }
      checks.rightRemovedFromRealDirectoryDescriptors = reduced.length > 0 && reduced.every((item) => (BigInt(item.after) & pathFilestatGet) === 0n);
      for (const [index, cwd] of cwds.entries()) {
        const suffix = index === 0 ? "cwd" : "procfd";
        const denied = await run(child, "denied-root-metadata", glob, cwd);
        accept(state, "denied-root-metadata-" + suffix, denied, denied.code === 2 && denied.stdout === "" && denied.stderr.includes("sorting by last modified isn't supported for .:") && denied.stderr.includes("Capabilities insufficient (os error 76)"));
        const fromStdin = await stdin(child, "stdin-without-path-metadata-right", ["--sort=modified", "needle-stdin", "-"], cwd);
        accept(state, "stdin-without-path-metadata-right-" + suffix, fromStdin, fromStdin.code === 0 && fromStdin.stdout === "needle-stdin\n" && fromStdin.stderr === "");
      }
      checks.publicCaseCount = state.count === 22;
      const after = snapshot(filesystem);
      checks.fixtureUnchanged = JSON.stringify(after) === JSON.stringify(before);
      checks.resourcesReleased = host.processes.size === 0 && wakes.size === 0;
      const ok = Object.values(checks).every(Boolean);
      return Response.json({ ok, calls, path, artifact, checks, caseChecks: state.count, officialArgs: { glob, grep }, rightsReduction: reduced, createdFiles, creationOrder: JSON.parse(seedOrder), mtimeOrder: sorted.map((name) => name.slice(2)), fixture: { before, after }, results }, { status: ok ? 200 : 500 });
    } catch (error) {
      return Response.json({ ok: false, calls, path, artifact, checks, error: String(error), stack: error.stack, results }, { status: 500 });
    } finally {
      await host?.processes.dispose();
      wakes.dispose();
      filesystem.dispose();
    }
  }
}

async function runRootCases(state, cwd, suffix) {
  const { child, checks } = state;
  const grepResult = await run(child, "exact-grep", grep, cwd);
  accept(state, "exact-grep-" + suffix, grepResult, grepResult.code === 0 && grepResult.stderr === "");
  const matches = grepResult.stdout.trim().split("\n").map(JSON.parse).filter((record) => record.type === "match");
  checks["grep-matches-" + suffix] = matches.length === entries.length;
  const cases = [
    ["exact-glob", glob, (r) => r.code === 0 && r.stderr === "" && same(list(r.stdout), sorted)],
    ["reverse-mtime", glob.map((arg) => arg === "--sort=modified" ? "--sortr=modified" : arg), (r) => r.code === 0 && r.stderr === "" && same(list(r.stdout), [...sorted].reverse())],
    ["implicit-cwd", glob.slice(0, -1), (r) => r.code === 0 && r.stderr === "" && same(list(r.stdout), entries.map(([name]) => name))],
    ["absolute-root", [...glob.slice(0, -1), "/work"], (r) => r.code === 0 && r.stderr === "" && same(list(r.stdout), entries.map(([name]) => "/work/" + name))],
    ["multiple-file-roots", ["--files", "--null", "--sort=modified", "/work/m-new.txt", "z-old.txt", "/work/a-mid.txt"], (r) => r.code === 0 && r.stderr === "" && same(list(r.stdout), ["z-old.txt", "/work/a-mid.txt", "/work/m-new.txt"])],
    ["missing-second-root", ["--files", "--sort=modified", "/work", "/missing-root"], (r) => r.code === 2 && r.stdout === "" && r.stderr.includes("sorting by last modified isn't supported for /missing-root:") && r.stderr.includes("No such file")],
    ["stdin-only", ["--sort=modified", "needle-stdin", "-"], (r) => r.code === 0 && r.stdout === "needle-stdin\n" && r.stderr === "", true],
    ["stdin-and-file", ["--sort=modified", "--no-heading", "--with-filename", "needle", "-", "/work/z-old.txt"], (r) => r.code === 0 && r.stdout.includes("needle-stdin") && /\/work\/z-old\.txt:(?:\d+:)?needle-after z-old\.txt/.test(r.stdout), true],
  ];
  for (const [name, args, expected, piped] of cases) {
    const result = piped ? await stdin(child, name, args, cwd) : await run(child, name, args, cwd);
    accept(state, name + "-" + suffix, result, expected(result));
  }
}

async function run(child, name, args, cwd) {
  return await new Promise((resolve) => child.execFile("/bin/rg", args, { cwd }, (error, stdout, stderr) => resolve({ name, cwd, args, code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));
}
async function stdin(child, name, args, cwd) {
  const process = child.spawn("/bin/rg", args, { cwd }); let stdout = "", stderr = "";
  process.stdout.on("data", (chunk) => { stdout += String(chunk); }); process.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return await new Promise((resolve, reject) => { process.once("error", reject); process.once("close", (code) => resolve({ name, cwd, args, code, stdout, stderr })); process.stdin.end("needle-stdin\n"); });
}
function accept(state, name, result, pass) {
  state.results.push(result); state.checks[name] = pass;
  if (!pass) throw new Error(name + " failed: " + JSON.stringify(result));
  state.count++;
  if (state.host.processes.size !== 0 || state.wakes.size !== 0) throw new Error("process or wake resources remain after " + name);
}
function list(output) { return output.split("\0").filter(Boolean); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function ensureDirectory(filesystem, path) { let created = false; try { filesystem.mkdir(path); created = true; } catch (error) { if (error?.code !== "EEXIST" || filesystem.stat(path).type !== "directory") throw error; } const stat = filesystem.stat(path); if (stat.type !== "directory" || stat.posix?.mode !== 0o755 || stat.posix.uid !== 1000 || stat.posix.gid !== 1000) throw new Error("fixture directory changed: " + path); return created; }
function ensureFile(filesystem, path, expected, mtimeNs) {
  let created = false;
  try { filesystem.stat(path); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY, 0o644), bytes = encoder.encode(expected);
    try { if (filesystem.write(fd, bytes, 0n) !== bytes.length) throw new Error("short fixture write: " + path); } finally { filesystem.close(fd); }
    filesystem.setTimes(path, { atimeNs: mtimeNs, mtimeNs }); created = true;
  }
  const stat = filesystem.stat(path), actual = readFile(filesystem, path);
  if (actual !== expected || stat.mtimeNs !== mtimeNs || stat.posix?.mode !== 0o644 || stat.posix.uid !== 1000 || stat.posix.gid !== 1000) throw new Error("fixture file changed: " + path);
  return created;
}
function readFile(filesystem, path) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const chunks = [];
    for (;;) { const target = new Uint8Array(1024), count = filesystem.read(fd, target, null); if (count === 0) break; chunks.push(new TextDecoder().decode(target.subarray(0, count))); }
    return chunks.join("");
  } finally { filesystem.close(fd); }
}
function snapshot(filesystem) {
  return entries.map(([name]) => { const path = "/work/" + name, stat = filesystem.stat(path); return { path, content: readFile(filesystem, path), mtimeNs: String(stat.mtimeNs), posix: stat.posix }; });
}
`;

/** Writes a static-WASM facet fixture from the pinned artifact and current source modules. */
export async function prepareRipgrepSortProof(destination: string, artifactPath?: string) {
  const cloudRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
  const packageRoot = NodePath.join(cloudRoot, "infra/kernelPrograms/ripgrep");
  const sourcePath = NodePath.resolve(artifactPath ?? NodePath.join(packageRoot, "bin/rg.wasm"));
  const bytes = await NodeFSP.readFile(sourcePath);
  if (
    bytes.byteLength !== KERNEL_RIPGREP_ARTIFACT.bytes ||
    digest(bytes) !== KERNEL_RIPGREP_ARTIFACT.sha256
  ) {
    throw new Error("ripgrep sort fixture artifact does not match its source pin");
  }
  const provenance = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageRoot, "provenance.json"), "utf8"),
  );
  if (
    provenance.artifact.bytes !== bytes.byteLength ||
    provenance.artifact.sha256 !== digest(bytes)
  ) {
    throw new Error("ripgrep sort fixture artifact disagrees with provenance");
  }
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module)
    .map(({ module, name }) => `${module}.${name}`)
    .sort();
  if (JSON.stringify(imports) !== JSON.stringify([...provenance.imports].sort()))
    throw new Error("ripgrep WASM import inventory changed");

  const outputDir = NodePath.resolve(destination);
  const source = PROOF_SOURCE.replace(ARTIFACT_MARKER, JSON.stringify(KERNEL_RIPGREP_ARTIFACT));
  if (source.includes(ARTIFACT_MARKER))
    throw new Error("ripgrep sort proof lost its artifact marker");
  const bundled = await Esbuild.build({
    absWorkingDir: cloudRoot,
    stdin: {
      sourcefile: "ripgrep-sort-proof.ts",
      resolveDir: cloudRoot,
      contents: source,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*", "cloudflare:workers", "*.wasm"],
    write: false,
  });
  const main = bundled.outputFiles?.[0]?.text;
  if (!main) throw new Error("ripgrep sort proof bundle was empty");
  if (!main.includes('import rg from "./rg.wasm"') || main.includes("WebAssembly.Module(")) {
    throw new Error(
      "ripgrep sort fixture must use static WASM without host Node imports or runtime compilation",
    );
  }
  await NodeFSP.mkdir(outputDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(outputDir, "main.js"), main);
  await NodeFSP.writeFile(NodePath.join(outputDir, "rg.wasm"), bytes);
  const manifest = {
    id: "kernel-ripgrep-sort-proof-v1",
    mainModule: "main.js",
    entrypoint: "RipgrepSortFacet",
    mode: "facet",
    allowOutbound: false,
    modules: {
      "main.js": { path: "main.js", type: "js" },
      "rg.wasm": { path: "rg.wasm", type: "wasm" },
    },
    paths: ["/proof", "/proof-again"],
  };
  await NodeFSP.writeFile(
    NodePath.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { artifact: KERNEL_RIPGREP_ARTIFACT, wasmImports: imports, manifest };
}

function digest(bytes: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination)
    throw new Error("Pass a destination directory for the ripgrep sort proof facet");
  const inventory = await prepareRipgrepSortProof(
    NodePath.resolve(destination),
    process.argv[3] && NodePath.resolve(process.argv[3]),
  );
  process.stdout.write(
    `${JSON.stringify({ destination: NodePath.resolve(destination), inventory }, null, 2)}\n`,
  );
}
