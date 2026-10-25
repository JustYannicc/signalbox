import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

if (![7, 8].includes(process.argv.length))
  throw new Error(
    "provide output/kernel snapshot/host snapshot/module/wrangler package entry/[optional exec snapshot]",
  );
const [output, kernelSource, hostSource, modulePath, wranglerEntry, execSource] = process.argv
  .slice(2)
  .map((value) => NodePath.resolve(value));
if (![output, kernelSource, hostSource, modulePath, wranglerEntry].every(Boolean))
  throw new Error(
    "provide output/kernel snapshot/host snapshot/module/wrangler package entry/[optional exec snapshot]",
  );
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const require = NodeModule.createRequire(wranglerEntry);
const { createTestHarness } = require(wranglerEntry);
await NodeFSP.mkdir(output, { recursive: false });
const inventory = [];
const snapshots = [];
for (const root of [kernelSource, ...(execSource ? [execSource] : []), hostSource]) {
  const manifest = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "manifest.json"), "utf8"));
  snapshots.push({ source: root, candidateDigest: manifest.candidateDigest });
  const entries = Array.isArray(manifest.files)
    ? manifest.files
    : Object.entries(manifest.files).map(([path, sha256]) => ({ path, sha256 }));
  for (const entry of entries) {
    if (
      !entry.path.endsWith(".ts") ||
      entry.path.endsWith(".test.ts") ||
      entry.path.startsWith("tests/")
    )
      continue;
    const bytes = await NodeFSP.readFile(NodePath.join(root, entry.path));
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("snapshot hash mismatch: " + entry.path);
    const path = NodePath.join(output, "kernel", entry.path.replace(/\.ts$/, ".js"));
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    const js = NodeModule.stripTypeScriptTypes(bytes.toString(), { mode: "transform" }).replaceAll(
      /(from\s*["']\.[^"']*)\.ts(["'])/g,
      "$1.js$2",
    );
    await NodeFSP.writeFile(path, js);
    inventory.push({ source: root, path: entry.path, sha256: entry.sha256 });
  }
}
await NodeFSP.copyFile(modulePath, NodePath.join(output, "probe.wasm"));
const { pollGuardBytes } = await import("./poll-guard.mjs");
await NodeFSP.writeFile(NodePath.join(output, "guard.wasm"), pollGuardBytes());
await NodeFSP.copyFile(
  NodePath.join(here, execSource ? "exec-worker.mjs" : "native-worker.mjs"),
  NodePath.join(output, "worker.js"),
);
await NodeFSP.copyFile(
  NodePath.join(here, "poll-guard.mjs"),
  NodePath.join(output, "poll-guard.js"),
);
const config = {
  name: "signalbox-ws-local-proof",
  main: NodePath.join(output, "worker.js"),
  no_bundle: true,
  find_additional_modules: true,
  base_dir: output,
  rules: [
    { type: "ESModule", globs: ["**/*.js"], fallthrough: true },
    { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true },
  ],
  compatibility_date: "2026-10-01",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: { bindings: [{ name: "PROOF", class_name: "ProofObject" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["ProofObject"] }],
};
await NodeFSP.writeFile(
  NodePath.join(output, "inventory.json"),
  JSON.stringify(inventory, null, 2),
);
await NodeFSP.writeFile(NodePath.join(output, "config.json"), JSON.stringify(config, null, 2));
const harness = createTestHarness({ workers: [{ config }] });
try {
  await harness.listen();
  const response = await harness.fetch("/proof");
  const result = await response.json();
  await NodeFSP.writeFile(NodePath.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!response.ok || !result.ok) process.exitCode = 1;
  const artifacts = [],
    modules = {};
  for (const entry of await NodeFSP.readdir(output, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = NodePath.join(entry.parentPath, entry.name);
    const relative = full.slice(output.length + 1);
    const bytes = await NodeFSP.readFile(full);
    artifacts.push({
      path: relative,
      bytes: bytes.length,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    });
    if (/\.(js|wasm)$/.test(relative))
      modules[relative] = { path: relative, type: relative.endsWith(".wasm") ? "wasm" : "js" };
  }
  const guest = await NodeFSP.readFile(modulePath);
  await NodeFSP.writeFile(
    NodePath.join(output, "evidence.json"),
    JSON.stringify(
      {
        ok: result.ok,
        scope: result.scope,
        snapshots,
        guestSha256: NodeCrypto.createHash("sha256").update(guest).digest("hex"),
        artifacts,
      },
      null,
      2,
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(output, "manifest.json"),
    JSON.stringify(
      {
        id: execSource ? "wasm-exec-protocol" : "wasm-native-websocket-transport",
        mainModule: "worker.js",
        entrypoint: "ProofObject",
        mode: "facet",
        paths: ["/proof", "/proof"],
        modules,
      },
      null,
      2,
    ),
  );
  for (const entry of await NodeFSP.readdir(output, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await NodeFSP.chmod(NodePath.join(entry.parentPath, entry.name), 0o444);
  }
} finally {
  await harness.close();
}
