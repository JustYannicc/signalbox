// @effect-diagnostics nodeBuiltinImport:off - build-time fixtures run the published modules under Node.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { entryExports, planSingleModule } from "./single-module.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

const fixturePlugin = (sources: Readonly<Record<string, string>>): Esbuild.Plugin => ({
  name: "fixture",
  setup(build) {
    build.onResolve({ filter: /^fixture:/ }, (args) => ({ path: args.path, namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
      contents: sources[args.path]!,
      loader: "js",
    }));
  },
});

async function tempRoot() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "single-module-"));
  roots.push(root);
  return root;
}

const shared = {
  entryNames: "[dir]/[name]",
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  metafile: true,
} satisfies Esbuild.BuildOptions;

async function publish(input: {
  readonly sources: Readonly<Record<string, string>>;
  readonly entries: Readonly<Record<string, string>>;
}) {
  const root = await tempRoot();
  const split = await Esbuild.build({
    ...shared,
    entryPoints: input.entries,
    outdir: root,
    splitting: true,
    plugins: [fixturePlugin(input.sources)],
  });
  const single = planSingleModule({
    mainEntry: "claude",
    entries: input.entries,
    exports: entryExports(split.metafile, root, input.entries),
  });
  const built = await Esbuild.build({
    ...shared,
    entryPoints: { [single.bundleName]: single.entryPoint },
    outdir: root,
    plugins: [single.plugin, fixturePlugin(input.sources)],
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
          "fixture:main": touch("main"),
          "fixture:worker": `${touch("worker")}const state={};export function get(){return state}export default state;`,
          "fixture:other": `${touch("other")}export const value="other";`,
        },
        entries: {
          claude: "fixture:main",
          "workers/one": "fixture:worker",
          "signalbox/release": "fixture:other",
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
      expect((await load("signalbox/release.js")).value).toBe("other");
      expect(hits).toEqual(["main", "worker", "other"]);
    } finally {
      Reflect.deleteProperty(globalThis, symbol);
    }
  });

  it("publishes export names that are reserved words or collide with facade locals", async () => {
    const { load } = await publish({
      sources: {
        "fixture:main": "",
        "fixture:worker": `const odd=1;export{odd as delete,odd as "not an identifier",odd as load,odd as entry,odd as v0};`,
      },
      entries: { claude: "fixture:main", "workers/one": "fixture:worker" },
    });
    const worker = await load("workers/one.js");
    expect([
      worker.delete,
      worker["not an identifier"],
      worker.load,
      worker.entry,
      worker.v0,
    ]).toEqual([1, 1, 1, 1, 1]);
  });

  it("publishes a CommonJS entry's exports as the default, shared with the release", async () => {
    const { load } = await publish({
      sources: {
        "fixture:main": 'import shared from "fixture:shared";export const fromMain=shared;',
        "fixture:shared": 'module.exports={value:"cjs"};',
      },
      entries: { claude: "fixture:main", "host/shared": "fixture:shared" },
    });
    const host = await load("host/shared.js");
    expect(host.default).toEqual({ value: "cjs" });
    expect(host.default).toBe((await load("claude.js")).fromMain);
  });

  it("keeps an entry's own __esModule export instead of esbuild's interop marker", async () => {
    const { load } = await publish({
      sources: {
        "fixture:main": "",
        "fixture:worker": "const marker=17;export{marker as __esModule};export const value=1;",
      },
      entries: { claude: "fixture:main", "workers/one": "fixture:worker" },
    });
    const worker = await load("workers/one.js");
    expect([worker.__esModule, worker.value]).toEqual([17, 1]);
  });

  it("rejects entries it can't place", async () => {
    const root = await tempRoot();
    const split = await Esbuild.build({
      ...shared,
      entryPoints: { claude: "fixture:main" },
      outdir: root,
      splitting: true,
      plugins: [fixturePlugin({ "fixture:main": "" })],
    });
    expect(() => entryExports(split.metafile, root, { missing: "fixture:main" })).toThrow(
      "BUNDLE_ENTRY_OUTPUT_MISSING: missing",
    );
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
