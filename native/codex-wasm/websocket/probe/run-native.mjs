import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { stripTypeScriptTypes, createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

if (![7, 8].includes(process.argv.length)) throw new Error("provide output/kernel snapshot/host snapshot/module/wrangler package entry/[optional exec snapshot]");
const [output, kernelSource, hostSource, modulePath, wranglerEntry, execSource] = process.argv.slice(2).map((value) => resolve(value));
if (![output, kernelSource, hostSource, modulePath, wranglerEntry].every(Boolean)) throw new Error("provide output/kernel snapshot/host snapshot/module/wrangler package entry/[optional exec snapshot]");
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(wranglerEntry);
const { createTestHarness } = require(wranglerEntry);
await mkdir(output, { recursive: false });
const inventory = [];
const snapshots = [];
for (const root of [kernelSource, ...(execSource ? [execSource] : []), hostSource]) {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  snapshots.push({ source: root, candidateDigest: manifest.candidateDigest });
  const entries = Array.isArray(manifest.files) ? manifest.files : Object.entries(manifest.files).map(([path, sha256]) => ({ path, sha256 }));
  for (const entry of entries) {
    if (!entry.path.endsWith(".ts") || entry.path.endsWith(".test.ts") || entry.path.startsWith("tests/")) continue;
    const bytes = await readFile(join(root, entry.path));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("snapshot hash mismatch: " + entry.path);
    const path = join(output, "kernel", entry.path.replace(/\.ts$/, ".js"));
    await mkdir(dirname(path), { recursive: true });
    const js = stripTypeScriptTypes(bytes.toString(), { mode: "transform" }).replaceAll(/(from\s*["']\.[^"']*)\.ts(["'])/g, "$1.js$2");
    await writeFile(path, js);
    inventory.push({ source: root, path: entry.path, sha256: entry.sha256 });
  }
}
await copyFile(modulePath, join(output, "probe.wasm"));
const { pollGuardBytes } = await import("./poll-guard.mjs");
await writeFile(join(output, "guard.wasm"), pollGuardBytes());
await copyFile(join(here, execSource ? "exec-worker.mjs" : "native-worker.mjs"), join(output, "worker.js"));
await copyFile(join(here, "poll-guard.mjs"), join(output, "poll-guard.js"));
const config = { name: "signalbox-ws-local-proof", main: join(output, "worker.js"), no_bundle: true,
  find_additional_modules: true, base_dir: output,
  rules: [{ type: "ESModule", globs: ["**/*.js"], fallthrough: true }, { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }],
  compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  durable_objects: { bindings: [{ name: "PROOF", class_name: "ProofObject" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["ProofObject"] }] };
await writeFile(join(output, "inventory.json"), JSON.stringify(inventory, null, 2));
await writeFile(join(output, "config.json"), JSON.stringify(config, null, 2));
const harness = createTestHarness({ workers: [{ config }] });
try {
  await harness.listen();
  const response = await harness.fetch("/proof");
  const result = await response.json();
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!response.ok || !result.ok) process.exitCode = 1;
  const { readdir, chmod } = await import("node:fs/promises");
  const artifacts = [], modules = {};
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const relative = full.slice(output.length + 1);
    const bytes = await readFile(full);
    artifacts.push({ path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    if (/\.(js|wasm)$/.test(relative)) modules[relative] = { path: relative, type: relative.endsWith(".wasm") ? "wasm" : "js" };
  }
  const guest = await readFile(modulePath);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ ok: result.ok, scope: result.scope, snapshots,
    guestSha256: createHash("sha256").update(guest).digest("hex"), artifacts }, null, 2));
  await writeFile(join(output, "manifest.json"), JSON.stringify({ id: execSource ? "wasm-exec-protocol" : "wasm-native-websocket-transport", mainModule: "worker.js",
    entrypoint: "ProofObject", mode: "facet", paths: ["/proof", "/proof"], modules }, null, 2));
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await chmod(join(entry.parentPath, entry.name), 0o444);
  }
} finally { await harness.close(); }
