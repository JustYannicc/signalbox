// @effect-diagnostics nodeBuiltinImport:off - executes generated native modules in Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { workerFactoryBuiltinSources } from "../harness-releases/nodeBuiltinGate/workerFactory.ts";
import { createWorkerFactory } from "./worker-factory.ts";

it.each([
  { binding: "value", references: 30000 },
  { binding: "sharedValue", references: 300000 },
])(
  "normalizes $references live $binding reads within the hooks packing allowance",
  ({ binding, references }) => {
    const mainSource = `import {${binding}} from "./worker-hooks.js";export function read(){return [${Array.from(
      { length: references },
      () => binding,
    ).join(",")}]}`;
    const workerSource = `var ${binding}=1;function launch(){}`;
    const generated = createWorkerFactory({
      workerSource,
      mainSource,
      workerImport: "./worker-hooks.js",
      exports: new Map([[binding, binding]]),
      initializers: [],
      launch: "launch",
    });
    const normalized = workerFactoryBuiltinSources([
      { name: "signalbox/worker-hooks.js", source: generated.workerSource },
      { name: "signalbox/release.js", source: generated.mainSource },
    ]);
    expect(normalized[1]!.source.match(/__signalboxAnalysis0/g)).toHaveLength(references + 1);
    const growth =
      Buffer.byteLength(generated.workerSource) +
      Buffer.byteLength(generated.mainSource) -
      Buffer.byteLength(workerSource) -
      Buffer.byteLength(mainSource);
    expect(growth).toBeLessThanOrEqual(524288);
  },
);

it("preserves live values, function receivers and getter timing across short reader calls", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "worker-readers-"));
  try {
    const generated = createWorkerFactory({
      workerSource: `let value=1,getterCalls=0;
let callable=function(){return this===undefined?"initial-free":"initial-bound"};
const object={get value(){getterCalls++;return value},method(){return [this===object,this.value]}};
class Thing{constructor(){this.value=value}}
function update(){value++;callable=function(){return this===undefined?"updated-free":"updated-bound"}}
function counts(){return getterCalls}
function tag(strings){return [this===undefined,strings[0],value]}
function launch(){}`,
      mainSource: `import {value,callable,object,Thing,update,counts,tag} from "./worker-hooks.js";
export function read(){return value}
export function bump(){update()}
export function direct(){return callable()}
export function optional(){return callable?.()}
export function method(){return object.method()}
export function getters(){return [object.value,object.value,counts()]}
export function construct(){return new Thing()}
export function tagged(){return tag\`template\`}
export function nested(){return ()=>value}
export function shorthand(){return {value}}
export function shadow($0,$1,r){return [$0,$1,r,value]}
export function escaped(\\u00242){return [\\u00242,value]}`,
      workerImport: "./worker-hooks.js",
      exports: new Map(
        ["value", "callable", "object", "Thing", "update", "counts", "tag"].map((name) => [
          name,
          name,
        ]),
      ),
      initializers: [],
      launch: "launch",
    });
    await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
    await NodeFSP.writeFile(NodePath.join(root, "worker-hooks.js"), generated.workerSource);
    await NodeFSP.writeFile(NodePath.join(root, "main.js"), generated.mainSource);
    await NodeFSP.writeFile(
      NodePath.join(root, "probe.mjs"),
      `const main=await import('./main.js');
const nested=main.nested();
const sample=()=>({value:main.read(),direct:main.direct(),optional:main.optional(),getters:main.getters(),method:main.method(),constructed:main.construct().value,tagged:main.tagged(),nested:nested(),shorthand:main.shorthand(),shadow:main.shadow("zero","one","r"),escaped:main.escaped("two")});
const first=sample();main.bump();const second=sample();
console.log(JSON.stringify([first,second]));`,
    );
    const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
      NodePath.join(root, "probe.mjs"),
    ]);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        value: 1,
        direct: "initial-free",
        optional: "initial-free",
        getters: [1, 1, 2],
        method: [true, 1],
        constructed: 1,
        tagged: [true, "template", 1],
        nested: 1,
        shorthand: { value: 1 },
        shadow: ["zero", "one", "r", 1],
        escaped: ["two", 1],
      },
      {
        value: 2,
        direct: "updated-free",
        optional: "updated-free",
        getters: [2, 2, 5],
        method: [true, 2],
        constructed: 2,
        tagged: [true, "template", 2],
        nested: 2,
        shorthand: { value: 2 },
        shadow: ["zero", "one", "r", 2],
        escaped: ["two", 2],
      },
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
