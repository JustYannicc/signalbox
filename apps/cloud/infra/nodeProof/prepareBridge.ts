// @effect-diagnostics nodeBuiltinImport:off - build-time preparation for the shared workerd probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

export async function prepareNodeBridgeProof(destination: string) {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    entryPoints: [
      NodeURL.fileURLToPath(new URL("../../src/isolate/NodeBootstrap.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Node runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  const layer = createNodeBridgeLayerModules(["fs", "fs/promises", "process"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "release-fixture.js",
      contents: `import fs, {readFileSync} from 'node:fs';
import * as namespace from 'fs';
import promises from 'fs/promises';
import process, {cwd} from 'node:process';
const common = require('fs');
const nodeCommon = require('node:fs');
const commonProcess = require('process');
const commonPromises = require('node:fs/promises');
export function check() {
  return {
    defaultIdentity: fs === common && common === nodeCommon,
    namespaceIdentity: namespace.default === fs,
    namedIdentity: readFileSync === fs.readFileSync && namespace.readFileSync === readFileSync,
    promisesIdentity: fs.promises === promises && promises === commonPromises,
    processIdentity: process === commonProcess && cwd === process.cwd,
    value: readFileSync('/work/value'),
    cwd: cwd(),
  };
}`,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "node-bridge-facades",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(layer, args.path)) return { path: args.path, namespace: "layer" };
            throw new Error(`Unexpected release import: ${args.path}`);
          });
          build.onLoad({ filter: /.*/, namespace: "layer" }, (args) => ({
            contents: layer[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("Node facade bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);
  const main = `import {DurableObject} from 'cloudflare:workers';
import {bootNodeRelease, installNodePersonality} from './runtime.js';
export class NodeBridgeFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS bridge_calls(n INTEGER)');
    this.ready = undefined;
  }
  async fetch(request) {
    try {
      if (new URL(request.url).pathname === '/poison') {
        const loaded = await this.ready;
        loaded.personality.restore();
        delete globalThis.Bun;
        const failure = new Error('deliberate poisoned global');
        let impossibleRollbackReported = false;
        try {
          await bootNodeRelease({modules:{},globals:{Bun:{}}}, async () => {
            Object.defineProperty(globalThis,'Bun',{value:{},configurable:false});
            throw failure;
          });
        } catch(error) {
          impossibleRollbackReported = error instanceof AggregateError && error.errors[0] === failure && error.errors[1].message.includes('Cannot restore');
        }
        const next = installNodePersonality({modules:{}});
        next.restore();
        if (!impossibleRollbackReported) throw new Error('Impossible rollback was hidden');
        return Response.json({ok:true,impossibleRollbackReported,note:'This final request deliberately poisons the Worker, which must now be discarded.'});
      }
      if (!this.ready) {
        let conflictRejected = false;
        try {installNodePersonality({modules:{fs:{},'fs/promises':{}}});}
        catch(error) {conflictRejected = error.code === 'NODE_BRIDGE_ALIAS_CONFLICT';}
        const previousBun = Object.getOwnPropertyDescriptor(globalThis, 'Bun');
        const failedImport = new Error('deliberate failed import');
        let originalErrorPreserved = false;
        try {
          await bootNodeRelease({modules:{},globals:{Bun:{}}}, async () => {
            Object.defineProperty(globalThis,'Bun',{value:{changed:true},configurable:true});
            throw failedImport;
          });
        } catch(error) {originalErrorPreserved = error === failedImport;}
        const restoredBun = Object.getOwnPropertyDescriptor(globalThis, 'Bun');
        if (!conflictRejected || !originalErrorPreserved || JSON.stringify(restoredBun) !== JSON.stringify(previousBun) || restoredBun?.value !== previousBun?.value) throw new Error('Failed import rollback failed');
        const promises = {readFile: async () => 'fixture'};
        const fs = {promises, readFileSync: path => {if (path !== '/work/value') throw new Error('unexpected path'); return 'host-value';}};
        const process = {cwd: () => '/work'};
        const bun = {main: '/signalbox/release.js'};
        this.ready = bootNodeRelease({modules:{fs,'fs/promises':promises,process},globals:{process,Bun:bun}}, () => import('./release.js'));
      }
      const {release} = await this.ready;
      const result = release.check();
      let duplicateRejected = false;
      try { installNodePersonality({modules:{fs:{}}}); }
      catch(error) {duplicateRejected = error.code === 'NODE_BRIDGE_ALREADY_INSTALLED';}
      if (!duplicateRejected || !Object.entries(result).every(([name,value]) => name === 'value' ? value === 'host-value' : name === 'cwd' ? value === '/work' : value === true)) throw new Error('Node facade identity failed');
      if (globalThis.process.cwd() !== '/work' || globalThis.Bun.main !== '/signalbox/release.js') throw new Error('Global initialization failed');
      this.ctx.storage.sql.exec('INSERT INTO bridge_calls VALUES (1)');
      const calls = this.ctx.storage.sql.exec('SELECT count(*) AS n FROM bridge_calls').one().n;
      return Response.json({ok:true,result,duplicateRejected,calls,note:'Bridge routing and host installation only. The fs/process objects are deliberate fixture hosts, not Node filesystem/process implementations.'});
    } catch(error) {return Response.json({ok:false,error:String(error)}, {status:500});}
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-bridge-alias-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeBridgeFacet",
        modules: Object.fromEntries(
          ["main.js", "runtime.js", "release.js"].map((path) => [path, { path, type: "js" }]),
        ),
        paths: ["/status", "/again", "/poison"],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a fixture output directory");
  await prepareNodeBridgeProof(NodePath.resolve(destination));
}
