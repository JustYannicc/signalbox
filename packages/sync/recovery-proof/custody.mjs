import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(import.meta.url);
const wrangler = NodeModule.createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = await import(wrangler.resolve("miniflare"));
const { build } = await import(wrangler.resolve("esbuild"));
const lunoraRoot = NodePath.resolve(
  NodeURL.fileURLToPath(import.meta.resolve("lunorash/server")),
  "../..",
);
const serverRoot = await NodeFSP.realpath(NodePath.join(lunoraRoot, "../@lunora/server"));
const serverManifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(serverRoot, "package.json"), "utf8"),
);
const inProcess = NodePath.join(serverRoot, serverManifest.exports["./in-process"].import);
const shardEngineRoot = await NodeFSP.realpath(NodePath.join(serverRoot, "../shard-engine"));
const engineManifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(shardEngineRoot, "package.json"), "utf8"),
);
const shardEngine = NodePath.join(shardEngineRoot, engineManifest.exports["."].import);
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sync-custody-"));
let miniflare;
try {
  const bundle = await build({
    entryPoints: [new URL("./custody-worker.ts", import.meta.url).pathname],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    alias: { "@lunora/server/in-process": inProcess, "@lunora/shard-engine": shardEngine },
  });
  const start = () =>
    new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { CUSTODY: { className: "CustodyProof", useSQLite: true } },
        resourcePersistencePath: directory,
      }),
    );
  const call = async (operation) =>
    (
      await miniflare.dispatchFetch("http://proof/", {
        method: "POST",
        body: JSON.stringify({ operation }),
      })
    ).json();
  miniflare = start();
  NodeAssert.deepEqual(await call("rollback"), { rows: 0, receipts: 0, custody: [], accepted: 0 });
  const committed = await call("apply");
  NodeAssert.equal(committed.rows, 1);
  NodeAssert.equal(committed.receipts, 1);
  NodeAssert.equal(committed.custody.length, 1);
  NodeAssert.equal(JSON.parse(committed.custody[0].envelopeJson).options.retry.forever, true);
  await miniflare.dispose();
  miniflare = start();
  const restarted = await call("inspect");
  NodeAssert.deepEqual(restarted, committed);
  NodeAssert.deepEqual(await call("apply"), committed);
  const transferred = await call("transfer");
  NodeAssert.deepEqual(transferred, { rows: 1, receipts: 1, custody: [], accepted: 1 });
  await miniflare.dispose();
  miniflare = start();
  NodeAssert.deepEqual(await call("inspect"), transferred);
  console.log(
    JSON.stringify({
      runtime: "workerd-sqlite",
      committedRows: 1,
      committedReceipts: 1,
      custodySurvivedRestart: true,
      duplicateReplayDidNotReschedule: true,
      transferredOnce: true,
    }),
  );
} finally {
  await miniflare?.dispose();
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
