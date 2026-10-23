import { expect, it } from "vite-plus/test";
import { createWorkerFactory } from "../../claude-bunfs/worker-factory.ts";
import { linkPublishedSources } from "./publishedGraph.ts";
import { scanBuiltinSource } from "./source.ts";
import { workerFactoryBuiltinSources } from "./workerFactory.ts";

it("keeps builtin checks across factory bindings, lazy shared exports and parent calls", async () => {
  const factory = createWorkerFactory({
    workerSource: `var __getOwnPropNames=Object.getOwnPropertyNames;var __commonJS=(cb,mod)=>function(){return mod||(0,cb[__getOwnPropNames(cb)[0]])((mod={exports:{}}).exports,mod),mod.exports};
var require_fs=__commonJS({"signalbox-layer:fs"(exports,module){var bridge=globalThis[Symbol.for("signalbox.nodeBridge.v1")];module.exports=bridge.require("fs")}});
var require_fs2=__commonJS({"embedded-other-label:node:fs"(exports,module){var bridge=globalThis[Symbol.for("signalbox.nodeBridge.v1")];if(!bridge){let error=new Error("Install the Node bridge before importing the release");throw error.code="NODE_BRIDGE_NOT_INSTALLED",error}module.exports=bridge.require("fs")}});
var fs;function init(){fs=require_fs()}function launch(){process.cwd();init();require_fs2().statSync("x");return fs.readFileSync("x")}`,
    mainSource: `import {init,fs} from "./worker-hooks.js"; export function run(){init();return fs.writeFileSync("x","y")}`,
    workerImport: "./worker-hooks.js",
    exports: new Map([
      ["init", "init"],
      ["fs", "fs"],
    ]),
    initializers: [],
    launch: "launch",
  });
  const linked = await linkPublishedSources([
    { name: "signalbox/worker-hooks.js", source: factory.workerSource },
    { name: "signalbox/release.js", source: factory.mainSource },
  ]);
  const scanned = scanBuiltinSource(linked);
  expect(
    scanned.requiredFunctions.map((item) => `${item.specifier}.${item.memberPath.join(".")}`),
  ).toEqual(
    expect.arrayContaining(["fs.readFileSync", "fs.writeFileSync", "fs.statSync", "process.cwd"]),
  );
  expect(scanned.functionAmbiguities).toEqual([]);
});

it("rejects an unknown factory shape when the worker module exists", () => {
  expect(() =>
    workerFactoryBuiltinSources([
      {
        name: "signalbox/worker-hooks.js",
        source: "export const factory = bindings => bindings.imports.fs;",
      },
    ]),
  ).toThrow("NODE_BUILTIN_WORKER_FACTORY_SHAPE_CHANGED");
});
