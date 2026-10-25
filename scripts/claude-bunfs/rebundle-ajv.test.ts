// @effect-diagnostics nodeBuiltinImport:off - execute generated multi-entry modules from temporary fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as Esbuild from "esbuild";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createAjvRebundleTransform } from "./rebundle-ajv.ts";

describe("AJV rebundle integration", () => {
  it("shares the compatibility failure state between the interpreter and the host", async () => {
    const layer = await createAjvRebundleTransform();
    const main = `import {createAjv,assertAjvCompatibility,resetAjvCompatibility} from 'signalbox:ajv/adapter';
      const Ajv=createAjv('2020');const ajv=new Ajv({strict:false,allErrors:true,validateFormats:false});
      const validate=ajv.compile({type:'object',properties:{name:{type:'string'}},required:['name']});
      export const good=validate({name:'test'});export const bad=!validate({name:1});
      export const meta=typeof ajv.getSchema('https://json-schema.org/draft/2020-12/schema')==='function';
      try {ajv.compile({$dynamicRef:'#node'})}catch{}
      export let latched=false;try{assertAjvCompatibility()}catch(error){latched=error.code==='AJV_SCHEMA_NOT_PRECOMPILED'}
      resetAjvCompatibility();assertAjvCompatibility();`;
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
            build.onLoad({ filter: /.*/, namespace: "layer" }, (args) => ({
              contents: layer.layerModules[args.path]!,
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
        NodeURL.pathToFileURL(NodePath.join(output, "signalbox/ajv-compatibility.js")).href
      );
      const release = await import(NodeURL.pathToFileURL(NodePath.join(output, "claude.js")).href);
      host.resetAjvCompatibility();
      expect(release.run({ $dynamicRef: "#node" }, {})).toBe("caught");
      expect(() => host.assertAjvCompatibility()).toThrow();
      host.resetAjvCompatibility();
      expect(release.run({ type: "string" }, "value")).toBe(true);
      expect(() => host.assertAjvCompatibility()).not.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
