// @effect-diagnostics nodeBuiltinImport:off - build the workerd fixture through the pinned Wrangler CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const output = NodeProcess.argv[2];
if (!output) throw new Error("Usage: node prepare-bun-proof.ts <output-directory>");
const directory = NodePath.resolve(output);
const cloud = NodeURL.fileURLToPath(new URL("../../apps/cloud/", import.meta.url));
const require = NodeModule.createRequire(new URL("../../apps/cloud/package.json", import.meta.url));
const wrangler = NodePath.join(
  NodePath.dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js",
);
await NodeFS.mkdir(directory, { recursive: true });
const config = NodePath.join(directory, "wrangler.json");
await NodeFS.writeFile(
  config,
  JSON.stringify(
    {
      name: "bun-shim-proof",
      main: NodePath.join(cloud, "src/isolate/tests/BunShim.fixture.ts"),
      compatibility_date: "2026-10-18",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: { bindings: [{ name: "PROOF", class_name: "BunShimProof" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["BunShimProof"] }],
    },
    null,
    2,
  ),
);
const result = NodeChildProcess.spawnSync(
  NodeProcess.execPath,
  [wrangler, "deploy", "--dry-run", "--config", config, "--outdir", directory],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Wrangler dry run failed with status ${result.status}`);
await NodeFS.writeFile(
  NodePath.join(directory, "manifest.json"),
  JSON.stringify(
    {
      id: "bun-shim-v1",
      mainModule: "BunShim.fixture.js",
      entrypoint: "BunShimProof",
      mode: "facet",
      modules: { "BunShim.fixture.js": { path: "BunShim.fixture.js", type: "js" } },
      paths: ["/", "/persistence"],
    },
    null,
    2,
  ),
);
