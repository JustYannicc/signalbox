// @effect-diagnostics nodeBuiltinImport:off - Builds isolated proof modules without starting a native probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

export async function prepareNodeAsyncHooksProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "async-hooks-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {createNodeAsyncHooks} from './isolate/NodeAsyncHooks.ts';
export {installNodePersonality} from './isolate/NodeBootstrap.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Async hooks proof runtime was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  const layer = createNodeBridgeLayerModules(["async_hooks"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "async-hooks-release.js",
      contents: `import hooksDefault,{AsyncLocalStorage} from 'node:async_hooks';
import * as hooksNamespace from 'async_hooks';
const commonJsHooks=require('async_hooks');
export function identity(module) {
  return hooksDefault===commonJsHooks && hooksNamespace.default===commonJsHooks &&
    commonJsHooks===module && AsyncLocalStorage===module.AsyncLocalStorage;
}
export function restoreCurrent(context) {
  const storage=new AsyncLocalStorage();
  return storage.run(context,()=>{
    const prior=storage.getStore(),current=storage.getStore();
    try{return storage.run(current,()=>storage.getStore());}
    finally{if(storage.getStore()===current)storage.enterWith(prior);}
  });
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "async-hooks-bridge",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.path in layer ? { path: args.path, namespace: "bridge" } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => {
            const contents = layer[args.path];
            if (contents === undefined) throw new Error("Unknown async hooks bridge module");
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("Async hooks release proof was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import { DurableObject } from "cloudflare:workers";
import * as hooks from "node:async_hooks";
import {createNodeAsyncHooks,installNodePersonality} from "./runtime.js";
const nativeEnter = hooks.AsyncLocalStorage.prototype.enterWith;
const guestHooks = createNodeAsyncHooks();
const EqualStoreAsyncLocalStorage = guestHooks.AsyncLocalStorage;
function nativeError(run) { try { run(); return false; } catch (e) { return e.message === "asyncLocalStorage.enterWith() is not implemented"; } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
export class EqualStoreFacet extends DurableObject {
  async fetch() {
    const checks = {};
    const storage = new EqualStoreAsyncLocalStorage();
    const outer = { name: "outer" }, a = { name: "a" }, b = { name: "b" };
    checks.nativeStillThrowsSame = new hooks.AsyncLocalStorage().run(outer, () => nativeError(() => { const n = new hooks.AsyncLocalStorage(); n.run(outer, () => n.enterWith(outer)); }));
    checks.outsideScopeStillThrows = nativeError(() => storage.enterWith(outer));
    checks.undefinedOutsideStillThrows = nativeError(() => storage.enterWith(undefined));
    let callbackStore;
    const result = storage.run(outer, () => {
      const before = storage.getStore();
      const current = storage.getStore();
      try { return storage.run(current, () => { callbackStore = storage.getStore(); return 17; }); }
      finally { if (storage.getStore() === current) storage.enterWith(before); }
    });
    checks.officialRestoration = result === 17 && callbackStore === outer && storage.getStore() === undefined;
    checks.sameScopePreserved = storage.run(outer, () => { storage.enterWith(outer); return storage.getStore() === outer; });
    checks.changedScopeStillThrows = storage.run(outer, () => nativeError(() => storage.enterWith(a)) && storage.getStore() === outer);
    const gate = deferred(); const seen = [];
    const pa = storage.run(a, async () => { storage.enterWith(a); await gate.promise; seen.push(storage.getStore() === a); storage.enterWith(a); await Promise.resolve(); return storage.getStore() === a; });
    const pb = storage.run(b, async () => { storage.enterWith(b); await Promise.resolve(); seen.push(storage.getStore() === b); gate.resolve(); await Promise.resolve(); return storage.getStore() === b; });
    checks.siblingIsolation = (await Promise.all([pa,pb])).every(Boolean) && seen.every(Boolean) && storage.getStore() === undefined;
    let snap, bound;
    storage.run(outer, () => { storage.enterWith(outer); snap = hooks.AsyncLocalStorage.snapshot(); bound = hooks.AsyncLocalStorage.bind(() => storage.getStore()); });
    checks.snapshot = storage.run(a, () => snap(() => { storage.enterWith(outer); return storage.getStore() === outer; }) && storage.getStore() === a);
    checks.bind = storage.run(b, () => bound() === outer && storage.getStore() === b);
    const failure = new Error("callback");
    try { storage.run(outer, () => { try { storage.run(outer, () => { throw failure; }); } finally { storage.enterWith(outer); } }); } catch (e) { checks.throwRestoration = e === failure && storage.getStore() === undefined; }
    checks.argumentForwarding = storage.run(outer, (x,y) => x+y, 2, 3) === 5;
    const isolated = new EqualStoreAsyncLocalStorage();
    checks.independentInstances = storage.run(a, () => isolated.run(b, () => { storage.enterWith(a); isolated.enterWith(b); return storage.getStore() === a && isolated.getStore() === b; }));
    checks.prototypeUnchanged = hooks.AsyncLocalStorage.prototype.enterWith === nativeEnter;
    checks.emptyScopesRestored = storage.getStore() === undefined;
    const nativeStorage = new hooks.AsyncLocalStorage();
    checks.nativeScopeUnaffected = nativeStorage.run(outer, () => storage.run(a, () => {
      storage.enterWith(a);
      return nativeStorage.getStore() === outer;
    }));
    const module = guestHooks;
    const owner = installNodePersonality({modules:{async_hooks:module}});
    try {
      const release = await import('./release.js');
      checks.bridgeAliases = release.identity(module);
      checks.bridgeLifecycle = release.restoreCurrent(outer) === outer;
    } finally { owner.restore(); }
    return Response.json({ok:Object.values(checks).every(Boolean), checks, note:"Equal active run store only; actual context switches retain native behavior. Official release startup is separate."});
  }
}
`,
  );

  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-async-hooks-current-store-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "EqualStoreFacet",
        modules: Object.fromEntries(
          ["main.js", "runtime.js", "release.js"].map((name) => [name, { path: name, type: "js" }]),
        ),
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}
