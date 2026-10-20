// @effect-diagnostics nodeBuiltinImport:off - build-time fixtures run the published modules under Node.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { planSingleModule } from "./single-module.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

async function publish(input: {
  readonly sources: Readonly<Record<string, string>>;
  readonly entries: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, readonly string[]>>;
}) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "single-module-"));
  roots.push(root);
  const single = planSingleModule({ mainEntry: "claude", ...input });
  const built = await Esbuild.build({
    entryPoints: { [single.bundleName]: single.entryPoint },
    outdir: root,
    entryNames: "[dir]/[name]",
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    plugins: [
      single.plugin,
      {
        name: "fixture",
        setup(build) {
          build.onResolve({ filter: /^fixture:/ }, (args) => ({
            path: args.path,
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: input.sources[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  for (const file of [...built.outputFiles, ...single.facades]) {
    const path = NodePath.resolve(root, file.path);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, file.contents);
  }
  await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
  const load = (path: string) => import(NodeURL.pathToFileURL(NodePath.join(root, path)).href);
  return { single, built, load };
}

describe("single-module release planning", () => {
  it("keeps every entry path while evaluating secondaries only when their facade loads", async () => {
    const symbol = Symbol.for(`signalbox.single-module.${NodeCrypto.randomUUID()}`);
    const hits: string[] = [];
    Reflect.set(globalThis, symbol, (name: string) => hits.push(name));
    const touch = (name: string) =>
      `globalThis[Symbol.for(${JSON.stringify(symbol.description)})](${JSON.stringify(name)});`;
    try {
      const { single, built, load } = await publish({
        sources: {
          "fixture:main": `${touch("main")}`,
          "fixture:worker": `${touch("worker")}const state={};export function get(){return state}const odd=1;export{odd as delete,odd as "not an identifier",odd as load,odd as entry,odd as v0};export default state;`,
          "fixture:cjs": `${touch("cjs")}module.exports={value:"cjs"};`,
        },
        entries: {
          claude: "fixture:main",
          "workers/one": "fixture:worker",
          "signalbox/release": "fixture:cjs",
        },
        exports: {
          claude: [],
          "workers/one": ["get", "delete", "not an identifier", "load", "entry", "v0", "default"],
          "signalbox/release": ["default"],
        },
      });
      expect(single.bundleName).toBe("signalbox/release_");
      expect(built.outputFiles).toHaveLength(1);
      expect(single.facades.map((file) => file.path).sort()).toEqual(
        ["claude.js", "signalbox/release.js", "workers/one.js"].sort(),
      );

      await load("claude.js");
      expect(hits).toEqual(["main"]);
      const worker = await load("workers/one.js");
      const again = await load("workers/one.js");
      expect(hits).toEqual(["main", "worker"]);
      expect(worker.default).toBe(worker.get());
      expect(again.get()).toBe(worker.get());
      expect([
        worker.delete,
        worker["not an identifier"],
        worker.load,
        worker.entry,
        worker.v0,
      ]).toEqual([1, 1, 1, 1, 1]);
      const cjs = await load("signalbox/release.js");
      expect(cjs.default).toEqual({ value: "cjs" });
      expect(hits).toEqual(["main", "worker", "cjs"]);
    } finally {
      Reflect.deleteProperty(globalThis, symbol);
    }
  });

  it("rejects entries it can't place", () => {
    expect(() =>
      planSingleModule({ mainEntry: "claude", entries: {}, exports: { claude: [] } }),
    ).toThrow("BUNDLE_ENTRY_MISSING: claude");
    expect(() =>
      planSingleModule({
        mainEntry: "claude",
        entries: { claude: "fixture:main", "workers/one": "fixture:worker" },
        exports: { claude: [] },
      }),
    ).toThrow("BUNDLE_ENTRY_EXPORTS_MISSING: workers/one");
  });
});
