// @effect-diagnostics nodeBuiltinImport:off - prepares modules for the shared workerd proof.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { NODE_VM_PREPARED_MODULES, prepareNodeVmModules } from "./prepareVm.ts";

export async function prepareNodeVmProof(destination: string, preparedDirectory?: string) {
  await NodeFSP.mkdir(destination, { recursive: true });
  if (preparedDirectory) {
    for (const name of Object.values(NODE_VM_PREPARED_MODULES)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(destination, name)), { recursive: true });
      await NodeFSP.copyFile(
        NodePath.join(preparedDirectory, name),
        NodePath.join(destination, name),
      );
    }
  } else {
    await prepareNodeVmModules(destination);
  }
  const runtime = await Esbuild.build({
    entryPoints: [NodeURL.fileURLToPath(new URL("../../src/isolate/NodeVm.ts", import.meta.url))],
    bundle: true,
    platform: "neutral",
    format: "esm",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Node vm runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "vm-runtime.js"), runtimeSource);
  const main = `import {DurableObject} from 'cloudflare:workers';
import * as nativeVm from 'node:vm';
import {createNodeVm} from './vm-runtime.js';
import primordialModule from './node/vm/interpreter-primordials.js';
import interpreterModule from './node/vm/interpreter.js';
import hostOps from './node/vm/host-ops.js';
import moduleHelpers from './node/vm/module-helpers.js';

const vm = createNodeVm(nativeVm, {
  createInterpreter: interpreterModule.createInterpreter,
  primordials: primordialModule.LAUNCH_PRIMORDIALS,
  hostOps,
  moduleHelpers,
});
function assert(value, message) { if (!value) throw new Error(message); }
export class NodeVmFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS vm_calls(n INTEGER)');
  }
  async fetch() {
    const checks = {};
    try {
      let nativeFunctionRefused = false;
      try { new Function('return 1')(); }
      catch(error) { nativeFunctionRefused = error.name === 'EvalError'; }
      assert(nativeFunctionRefused, 'The fixture did not reach request-time native codegen refusal');
      checks.nativeFunctionRefused = true;
      const shared = {count:0};
      globalThis.__signalboxVmProof = shared;
      try {
        const mutate = vm.module.compileFunction('__signalboxVmProof.count += amount; return __signalboxVmProof', ['amount']);
        assert(mutate(2) === shared && shared.count === 2, 'Object identity was lost');
        checks.localObjectIdentity = true;
      } finally { delete globalThis.__signalboxVmProof; }
      assert(vm.module.runInThisContext('1 + 2') === 3, 'Expression evaluation failed');
      checks.expression = true;
      const counter = vm.functionConstructors.Function('let n = 0; return () => ++n')();
      assert(counter() === 1 && counter() === 2, 'Closure state was lost');
      checks.closure = true;
      assert(vm.functionConstructors.Function('return this')() === globalThis, 'Sloppy this differs');
      assert(vm.functionConstructors.Function('"use strict"; return this')() === undefined, 'Strict this differs');
      checks.strictAndSloppy = true;
      assert(await vm.functionConstructors.AsyncFunction('return 23')() === 23, 'Async Function failed');
      assert(vm.functionConstructors.GeneratorFunction('yield 29')().next().value === 29, 'Generator Function failed');
      assert((await vm.functionConstructors.AsyncGeneratorFunction('yield 31')().next()).value === 31, 'Async generator failed');
      checks.functionKinds = true;
      const push = Object.getOwnPropertyDescriptor(Array.prototype, 'push');
      let parsed;
      Object.defineProperty(Array.prototype, 'push', {value(){throw new Error('Guest array push reached parser');},configurable:true,writable:true});
      try { parsed = vm.module.compileFunction('return 41')(); }
      finally { Object.defineProperty(Array.prototype, 'push', push); }
      assert(parsed === 41, 'Parser did not preserve launch primordials');
      checks.primordials = true;
      let unsupported = false;
      try { vm.module.compileFunction('return 1', [], {timeout:1}); }
      catch(error) { unsupported = error.code === 'ERR_NODE_VM_UNSUPPORTED_OPTION'; }
      assert(unsupported, 'Unsupported timeout was silently accepted');
      checks.unsupportedOptions = true;
      const previous = globalThis.Function;
      const installation = vm.functionConstructors.install();
      try { assert(new Function('return 47')() === 47, 'Global Function installation failed'); }
      finally { installation.restore(); }
      assert(globalThis.Function === previous, 'Global Function was not restored');
      checks.globalInstallation = true;
      this.ctx.storage.sql.exec('INSERT INTO vm_calls VALUES (1)');
      const calls = this.ctx.storage.sql.exec('SELECT count(*) AS n FROM vm_calls').one().n;
      return Response.json({ok:true,checks,calls,note:'Local synchronous interpreter fallback only. Async generated Workers and next-boot code staging are separate.'});
    } catch(error) { return Response.json({ok:false,checks,error:String(error),stack:error.stack}, {status:500}); }
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-vm-fallback-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeVmFacet",
        modules: {
          "main.js": { path: "main.js", type: "js" },
          "vm-runtime.js": { path: "vm-runtime.js", type: "js" },
          ...Object.fromEntries(
            Object.values(NODE_VM_PREPARED_MODULES).map((path) => [path, { path, type: "cjs" }]),
          ),
        },
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareNodeVmProof(NodePath.resolve(destination), process.argv[3]);
}
