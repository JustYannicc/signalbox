// @effect-diagnostics nodeBuiltinImport:off - execute generated multi-entry modules from temporary fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as Esbuild from "esbuild";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { rebundleClaudeRelease } from "./rebundle.ts";
import { createAjvRebundleTransform } from "./rebundle-ajv.ts";

const workerName = "/$bunfs/root/src/plugins/functionHooks/hooks-worker/hooks-worker.js";
const guardedModuleName = "/$bunfs/root/chunk-d9dwvjv9.js";

async function makeAjvWorkerExtraction(root: string) {
  const extracted = NodePath.join(root, "extracted");
  const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const modules = [
    {
      name: "/$bunfs/root/cli",
      source: `export const worker = ${JSON.stringify(workerName)};`,
    },
    {
      name: workerName,
      source: `export {validate} from ${JSON.stringify(guardedModuleName)};`,
    },
    {
      name: guardedModuleName,
      source: `
        class Base {}
        class Embedded extends Base {
          _addVocabularies() {}
          _addDefaultMetaSchema() {}
          defaultMeta() {}
        }
        const library = { Ajv: Embedded };
        export const validate = (schema) => new library.Ajv({ strict: false }).compile(schema);
      `,
    },
  ];
  const manifestModules = [];
  for (const [index, module] of modules.entries()) {
    const contents = new TextEncoder().encode(module.source);
    const path = `source/${index}.js`;
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(extracted, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(extracted, path), contents);
    manifestModules.push({
      index,
      name: module.name,
      key: module.name.replace(/^\/+/, ""),
      loader: 1,
      encoding: 0,
      format: 1,
      artifacts: { contents: { path, bytes: contents.byteLength, sha256: digest(contents) } },
    });
  }
  await NodeFSP.writeFile(
    NodePath.join(extracted, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      binary: { bytes: 1, sha256: digest(new Uint8Array([0])) },
      graph: { entry: 0 },
      modules: manifestModules,
    }),
  );
  return extracted;
}

describe("AJV rebundle integration", () => {
  it("shares the compatibility failure state between the interpreter and the host", async () => {
    const layer = await createAjvRebundleTransform({ workerCompatibility: true });
    const main = `import {createAjv,assertAjvCompatibility} from 'signalbox:ajv/adapter';
      import {assertAjvCompatibility as assertHost} from 'signalbox:ajv/compatibility';
      const Ajv=createAjv('2020');const ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});
      const validate=ajv.compile({type:'object',properties:{name:{type:'string'}},required:['name']});
      export const good=validate({name:'test'});export const bad=!validate({name:1});
      export const meta=typeof ajv.getSchema('https://json-schema.org/draft/2020-12/schema')==='function';
      try {ajv.compile({$dynamicRef:'#node'})}catch{}
      export let latched=false;try{assertAjvCompatibility()}catch(error){latched=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}
      export {assertHost};`;
    const result = await Esbuild.build({
      stdin: { contents: main, loader: "js", sourcefile: "proof.js" },
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      plugins: [
        {
          name: "ajv-test-layer",
          setup(build) {
            build.onResolve({ filter: /^signalbox:ajv\// }, (args) => ({
              path: args.path,
              namespace: "layer",
            }));
            build.onResolve({ filter: /^node:worker_threads$/ }, () => ({
              path: "worker_threads",
              namespace: "worker-runtime",
            }));
            build.onLoad({ filter: /.*/, namespace: "layer" }, (args) => ({
              contents: layer.layerModules[args.path]!,
              loader: "js",
            }));
            build.onLoad({ filter: /.*/, namespace: "worker-runtime" }, () => ({
              contents: `
                export const runtimeFailure = Promise.withResolvers();
                export function reportRuntimeFailure(error) {
                  globalThis[Symbol.for("signalbox.test.ajv-runtime-failure")] = error;
                }
                export async function assertRuntimeCompatibility() {}
              `,
              loader: "js",
            }));
          },
        },
      ],
    });
    const generated = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString("base64")}`
    );
    expect({
      good: generated.good,
      bad: generated.bad,
      meta: generated.meta,
      latched: generated.latched,
    }).toEqual({ good: true, bad: true, meta: true, latched: true });
    expect(Reflect.get(globalThis, Symbol.for("signalbox.test.ajv-runtime-failure"))).toMatchObject(
      {
        code: "AJV_SCHEMA_NOT_PRECOMPILED",
      },
    );
    expect(() => generated.assertHost()).toThrow(/AJV schema/);
  });
  it("publishes a stable host entry sharing the transformed release's caught failure state", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ajv-host-entry-"));
    try {
      const layer = await createAjvRebundleTransform();
      const main = await layer.transform({
        key: "embedded.js",
        name: "embedded.js",
        format: 1,
        source: `
        class Base {}
        class EmbeddedAjv extends Base {
          _addVocabularies() {} _addDefaultMetaSchema() {} defaultMeta() {}
        }
        const library={};library.Ajv=EmbeddedAjv;
        export function run(schema,data) {
          const ajv=new library.Ajv({strict:false,validateFormats:false});
          try { return ajv.compile(schema)(data); } catch { return "caught"; }
        }`,
      });
      expect(layer.report().constructors).toHaveLength(1);
      const modules: Record<string, string> = { ...layer.layerModules, "release-entry": main };
      const output = NodePath.join(root, "output");
      const built = await Esbuild.build({
        entryPoints: { claude: "release-entry", ...layer.hostEntrypoints },
        outdir: output,
        bundle: true,
        splitting: true,
        format: "esm",
        platform: "browser",
        write: false,
        plugins: [
          {
            name: "ajv-output-test",
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) =>
                Object.hasOwn(modules, args.path)
                  ? { path: args.path, namespace: "layer" }
                  : undefined,
              );
              build.onLoad({ filter: /.*/, namespace: "layer" }, (args) => ({
                contents: modules[args.path]!,
                loader: "js",
              }));
            },
          },
        ],
      });
      await NodeFSP.mkdir(output, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(output, "package.json"), '{"type":"module"}');
      for (const file of built.outputFiles) {
        await NodeFSP.mkdir(NodePath.dirname(file.path), { recursive: true });
        await NodeFSP.writeFile(file.path, file.contents);
      }
      const host = await import(
        NodeURL.pathToFileURL(NodePath.join(output, "signalbox/runtime-compatibility.js")).href
      );
      const release = await import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href);
      expect(release.run({ type: "string" }, "value")).toBe(true);
      expect(() => host.assertAjvCompatibility()).not.toThrow();
      expect(release.run({ $dynamicRef: "#node" }, {})).toBe("caught");
      expect(() => host.assertAjvCompatibility()).toThrow();
      expect(() => host.assertAjvCompatibility()).toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the smallest worker graph that reaches a guarded AJV module", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ajv-worker-gate-"));
    try {
      const extracted = await makeAjvWorkerExtraction(root);
      const output = NodePath.join(root, "bundle");
      await expect(
        rebundleClaudeRelease({ extracted, output, version: "fixture", platform: "linux-x64" }),
      ).rejects.toThrow(
        `AJV_WORKER_COMPATIBILITY_UNOBSERVED: ${workerName}: bun-graph:${guardedModuleName}`,
      );
      await expect(NodeFSP.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
