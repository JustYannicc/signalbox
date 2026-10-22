// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Observe the staged inventory inside a real WorkerLoader callback.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { encodeModuleTransport } from "../../../infra/isolateProbe/moduleTransport.ts";

const root = NodeURL.fileURLToPath(new URL("../../../../../", import.meta.url));
let directory: string | undefined;
let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: string;

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "product-graph-"));
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import {DurableObject} from "cloudflare:workers";
import {ModuleUploadStore} from "./apps/cloud/infra/isolateProbe/moduleUpload.ts";
export class StageProbe extends DurableObject {
  store = new ModuleUploadStore(this.ctx.storage.sql);
  async fetch(request) {
    const upload = await this.store.stage(request.body);
    const inventories = [];
    let boot;
    try {
      const worker = this.env.LOADER.get(upload.input.id, async () => {
        const modules = await upload.readModules();
        inventories.push(Object.keys(modules).sort());
        return {mainModule:"main.js", modules, compatibilityDate:"2026-10-18",
          compatibilityFlags:["nodejs_compat"], globalOutbound:null};
      });
      const facet = this.ctx.facets.get(upload.input.id, () => ({class:worker.getDurableObjectClass("GraphFacet")}));
      boot = await (await facet.fetch("https://probe.invalid/")).json();
    } finally { upload.dispose(); }
    const remaining = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM probe_module_upload").one().n;
    return Response.json({boot, inventories, remaining});
  }
}
export default {fetch(request,env){return env.STAGE.get(env.STAGE.idFromName("graph")).fetch(request)}};`,
    },
    outfile: NodePath.join(directory, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  const configPath = NodePath.join(directory, "wrangler.json");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "product-graph-test",
      main: "worker.js",
      no_bundle: true,
      compatibility_date: "2026-10-18",
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: { bindings: [{ name: "STAGE", class_name: "StageProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StageProbe"] }],
    }),
  );
  harness = createTestHarness({ workers: [{ configPath }] });
  endpoint = (await harness.listen()).url.toString();
}, 15000);

afterAll(async () => {
  try {
    await harness?.close();
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.each(["Claude", "Codex"])(
  "boots the %s entry from the SQL-staged WorkerLoader inventory",
  async (harnessName) => {
    const entry = `Product${harnessName}HarnessSessionHost`;
    const factory = `createProduct${harnessName}HarnessSessionHost`;
    const result = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: NodePath.join(root, "apps/cloud/src/harness"),
        contents: `import {DurableObject} from "cloudflare:workers";
import {${factory}} from "./${entry}.ts";
export class GraphFacet extends DurableObject {fetch(){return Response.json({factory:typeof ${factory}})}}`,
      },
      outfile: "facet/main.js",
      bundle: true,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers", "node:*"],
      metafile: true,
      write: false,
    });
    const excluded =
      harnessName === "Claude"
        ? /(?:^|\/)packages\/provider-codex\/|(?:^|\/)packages\/effect-codex-app-server\/|\/harness\/(?:Codex[^/]*\.ts|codex\/)/
        : /(?:^|\/)packages\/provider-claude\/|\/harness\/(?:Claude[^/]*\.ts|claude\/)/;
    expect(Object.keys(result.metafile.inputs).filter((path) => excluded.test(path))).toEqual([]);
    const modules = result.outputFiles.map((file) => ({
      name: NodePath.basename(file.path),
      type: "js" as const,
      bytes: file.contents,
    }));
    const packet = await new Response(
      encodeModuleTransport({ id: harnessName }, modules),
    ).arrayBuffer();
    const response = await fetch(endpoint, { method: "POST", body: packet });
    expect(response.status, await response.clone().text()).toBe(200);
    const observed: { boot: unknown; inventories: string[][]; remaining: number } =
      await response.json();
    expect(observed.boot).toEqual({ factory: "function" });
    expect(observed.inventories.length).toBeGreaterThan(0);
    for (const inventory of observed.inventories)
      expect(inventory).toEqual(modules.map((module) => module.name).sort());
    expect(observed.remaining).toBe(0);
  },
);
