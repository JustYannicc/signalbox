// @effect-diagnostics nodeBuiltinImport:off - verifies generated native modules in Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { createWorkerFactory } from "./worker-factory.ts";

it("binds parent realm values when the main module declares the same names", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-realm-"));
  try {
    const generated = createWorkerFactory({
      workerSource: "function launch(){return [K,dn,globalThis.marker,require('marker')]}",
      mainSource: `import {launch} from "./worker-hooks.js";
const K="local K",dn="local dn",globalThis={marker:"local global"},Object="local Object";
export {K,dn};export function run(){return launch()}`,
      workerImport: "./worker-hooks.js",
      exports: new Map([["launch", "launch"]]),
      initializers: [],
      launch: "launch",
    });
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(NodePath.join(root, "worker-hooks.js"), generated.workerSource);
    await NodeFSP.writeFile(
      NodePath.join(root, "main.js"),
      `const require=()=>"parent require";\n${generated.mainSource}`,
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "probe.mjs"),
      `
globalThis.K="realm K";globalThis.dn="realm dn";globalThis.marker="realm global";
const main=await import('./main.js');
console.log(JSON.stringify({result:main.run(),locals:[main.K,main.dn]}));`,
    );
    const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
      NodePath.join(root, "probe.mjs"),
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      result: ["realm K", "realm dn", "realm global", "parent require"],
      locals: ["local K", "local dn"],
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("shares compiled factory code with fresh state and preserves live references and call receivers", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-factory-"));
  try {
    const generated = createWorkerFactory({
      workerSource: `import * as host from "node:worker_threads";
import {marker as liveMarker} from "node:worker_threads";
var value; function initialize(){value={stamp:process.stamp,global:globalThis.marker,host:host.marker}}
function receiver(){return this} class Thing {constructor(){this.value=value}}
function live(){return liveMarker}
function launch(){initialize();return value}`,
      mainSource: `import {value as v,initialize as init,receiver as fn,Thing as T} from "./worker-hooks.js";
export function read(){return v} export function start(){init();return {v}}
export function receiver(){return fn()} export function construct(){return new T()}
export function shadow(v){return v} export function nested(){return ()=>v}`,
      workerImport: "./worker-hooks.js",
      exports: new Map([
        ["value", "value"],
        ["initialize", "initialize"],
        ["receiver", "receiver"],
        ["Thing", "Thing"],
        ["live", "live"],
      ]),
      initializers: [],
      launch: "launch",
    });
    expect(generated.globals).toEqual(["globalThis", "process"]);
    expect(generated.imports).toEqual(["node:worker_threads"]);
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(NodePath.join(root, "worker-hooks.js"), generated.workerSource);
    // The parent provider supplies the ordinary globals and builtin namespaces.
    const mainSource = generated.mainSource.replace(
      'require("node:worker_threads")',
      '({marker:"parent-host"})',
    );
    await NodeFSP.writeFile(NodePath.join(root, "main.js"), mainSource);
    await NodeFSP.writeFile(
      NodePath.join(root, "probe.mjs"),
      `
import {instantiate} from './worker-hooks.js';
globalThis.marker='parent';process.stamp='parent';
const main=await import('./main.js');
if(main.read()!==undefined)throw Error('eager');
const parent=main.start().v;
if(parent!==main.read()||parent!==main.nested()()||main.construct().value!==parent)throw Error('stale');
if(main.receiver()!==undefined||main.shadow(42)!==42)throw Error('scope');
const bind=stamp=>({globals:{process:{stamp},globalThis:{marker:stamp}},imports:{'node:worker_threads':{marker:stamp}}});
const bindingsA=bind('a'),a=instantiate(bindingsA),b=instantiate(bind('b'));
if(a.read(0)!==undefined||b.read(0)!==undefined)throw Error('shared initial state');
const first=a.launch(),second=b.launch();
if(first===second||first.stamp!=='a'||second.stamp!=='b'||first.global!=='a'||second.host!=='b')throw Error('bindings');
if(a.read(0)!==first||b.read(0)!==second||main.read()!==parent)throw Error('state leak');
bindingsA.imports['node:worker_threads'].marker='updated';
if(a.read(4)()!=='updated')throw Error('snapshot import');
console.log('ok');`,
    );
    const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
      NodePath.join(root, "probe.mjs"),
    ]);
    expect(result.stdout.trim()).toBe("ok");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it.each(["arguments", "this", "()=>this", "import.meta.url", 'import("external")'])(
  "rejects unbound module syntax: %s",
  (source) => {
    expect(() =>
      createWorkerFactory({
        workerSource: `const launch=()=>${source};`,
        mainSource: 'import {launch} from "./worker-hooks.js";',
        workerImport: "./worker-hooks.js",
        exports: new Map([["launch", "launch"]]),
        initializers: [],
        launch: "launch",
      }),
    ).toThrow(/BUNDLE_WORKER_/);
  },
);
it("rejects a static re-export whose live import cannot be represented", () => {
  expect(() =>
    createWorkerFactory({
      workerSource: "var value;function launch(){}",
      mainSource: 'import {value} from "./worker-hooks.js"; export {value};',
      workerImport: "./worker-hooks.js",
      exports: new Map([["value", "value"]]),
      initializers: [],
      launch: "launch",
    }),
  ).toThrow("BUNDLE_WORKER_LIVE_REEXPORT_UNSUPPORTED");
});
