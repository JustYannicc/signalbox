import { describe, expect, it } from "@effect/vitest";
import { inventoryCodegenFeatures } from "./codegen-inventory.ts";

describe("Claude release code generation inventory", () => {
  it("finds direct and aliased codegen entry points plus procfs literals", () => {
    const findings = inventoryCodegenFeatures([
      {
        name: "runtime.js",
        key: "$bunfs/runtime.js",
        source: `
import * as vm from "node:vm";
import { Script as VmScript } from "vm";
const vmAlias = vm;
function nestedVmAlias() { const nestedVm = vm; nestedVm.runInThisContext("1"); }
const awaitedVm = await import("node:vm");
awaitedVm.runInThisContext("awaited");
await awaitedVm.compileFunction("return 1");
function shadowVm(vm) { vm.runInContext("not node vm"); }
const { runInContext } = require("vm");
const factory = Function;
eval("return 1");
new Function("return 2");
vmAlias.runInNewContext("1");
new VmScript("1");
runInContext("1", {});
WebAssembly.compile(bytes);
WebAssembly.instantiate(bytes);
new WebAssembly.Module(bytes);
WebAssembly.compileStreaming(response);
WebAssembly.instantiateStreaming(response);
globalThis["Function"]("return 3");
const maps = "/proc/self/maps";
function local(eval, Function, WebAssembly) {
  eval("not global");
  new Function("not global");
  WebAssembly.compile(bytes);
}
`,
      },
    ]);

    expect(findings.map(({ kind, operation }) => `${kind}:${operation}`)).toEqual([
      "vm:vm.runInThisContext",
      "vm:vm.runInThisContext",
      "vm:vm.compileFunction",
      "Function:Function:reference",
      "eval:eval:call",
      "Function:Function:construct",
      "vm:vm.runInNewContext",
      "vm:vm.Script",
      "vm:vm.runInContext",
      "WebAssembly.compile:WebAssembly.compile",
      "WebAssembly.instantiate:WebAssembly.instantiate",
      "WebAssembly.Module:WebAssembly.Module",
      "WebAssembly.compileStreaming:WebAssembly.compileStreaming",
      "WebAssembly.instantiateStreaming:WebAssembly.instantiateStreaming",
      "Function:Function:call",
      "proc-path:literal contains /proc/",
    ]);
    expect(
      findings.every(
        (finding) => finding.module === "runtime.js" && finding.key === "$bunfs/runtime.js",
      ),
    ).toBe(true);
    expect(findings.find((finding) => finding.kind === "proc-path")?.literal).toBe(
      "/proc/self/maps",
    );
  });

  it("sorts findings independently of input module order", () => {
    const findings = inventoryCodegenFeatures([
      { name: "z.js", key: "z", source: "eval('z');" },
      { name: "a.js", key: "a", source: "eval('a');" },
    ]);
    expect(findings.map((finding) => `${finding.module}:${finding.key}`)).toEqual([
      "a.js:a",
      "z.js:z",
    ]);
  });
  it("records WASM namespace references, VM imports and escapes, async constructors and the proc root", () => {
    const findings = inventoryCodegenFeatures([
      {
        name: "entry.js",
        key: "entry.js",
        source: `
const W = WebAssembly;
W.instantiate(bytes);
const {compile} = WebAssembly;
pass(globalThis.WebAssembly);
WebAssembly[member](bytes);
(await import("node:vm")).runInThisContext(code);
import("vm").then((vm) => vm.compileFunction(code));
import * as vm from "vm";
pass(vm);
use(import("node:vm"));
import("vm").then(handler);
Object.getPrototypeOf(async function(){}).constructor;
(async () => {}).constructor(code);
fs.readdirSync("/proc");
const prefix = "/process";
function local(WebAssembly, Object) {
  pass(WebAssembly);
  Object.getPrototypeOf(async function(){}).constructor;
}
`,
      },
    ]);
    expect(findings.map((item) => `${item.kind}:${item.operation}`)).toEqual([
      "WebAssembly:WebAssembly:reference",
      "WebAssembly:WebAssembly:reference",
      "WebAssembly:WebAssembly:reference",
      "WebAssembly:WebAssembly:reference",
      "vm:vm.runInThisContext",
      "vm:vm.compileFunction",
      "vm:vm:reference",
      "vm:vm:reference",
      "vm:vm:reference",
      "Function:AsyncFunction:reference",
      "Function:AsyncFunction:call",
      "proc-path:literal contains /proc/",
    ]);
    expect(findings.find((item) => item.kind === "proc-path")?.literal).toBe("/proc");
  });

  it("canonicalizes WASM dot and static bracket operations", () => {
    const scan = (source: string) =>
      inventoryCodegenFeatures([{ name: "entry.js", key: "entry.js", source }]).map(
        ({ kind, operation }) => ({ kind, operation }),
      );
    expect(scan(`WebAssembly.instantiate(bytes)`)).toEqual(
      scan(`WebAssembly["instantiate"](bytes)`),
    );
  });
  it("classifies constructor access from every function literal kind", () => {
    const findings = inventoryCodegenFeatures([
      {
        name: "entry.js",
        key: "entry.js",
        source: `
(function(){}).constructor("return 1")();
(() => {}).constructor;
Object.getPrototypeOf(function*(){}).constructor("yield 1");
(function*(){}).constructor;
Object.getPrototypeOf(async function(){}).constructor;
(async function*(){}).constructor("yield 1");
Object.getPrototypeOf(async function*(){}).constructor;
function shadow(Object) { Object.getPrototypeOf(function*(){}).constructor("unknown"); }
`,
      },
    ]);
    expect(findings.map(({ kind, operation }) => `${kind}:${operation}`)).toEqual([
      "Function:Function:call",
      "Function:Function:reference",
      "Function:GeneratorFunction:call",
      "Function:GeneratorFunction:reference",
      "Function:AsyncFunction:reference",
      "Function:AsyncGeneratorFunction:call",
      "Function:AsyncGeneratorFunction:reference",
    ]);
  });
});
