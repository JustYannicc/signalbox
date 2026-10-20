// @effect-diagnostics nodeBuiltinImport:off - Builds the watcher proof without starting a probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

export async function prepareNodeWatchProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "watch-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
export {createNodeFs} from './isolate/NodeFs.ts';
export {createNodePath} from './isolate/NodePath.ts';
export {bootNodeRelease} from './isolate/NodeBootstrap.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
    metafile: true,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Watcher runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  const layer = createNodeBridgeLayerModules(["fs", "fs/promises", "path", "path/posix"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "watch-release.js",
      resolveDir: NodeURL.fileURLToPath(new URL("../../", import.meta.url)),
      contents: releaseSource,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    metafile: true,
    plugins: [
      {
        name: "watch-fs-facades",
        setup(build) {
          build.onResolve(
            { filter: /^(?:node:)?(?:fs(?:\/promises)?|path(?:\/posix)?)$/ },
            (args) => ({ path: args.path, namespace: "bridge" }),
          );
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => ({
            contents: layer[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const releaseText = release.outputFiles?.[0]?.text;
  if (!releaseText) throw new Error("Watcher release bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseText);
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), mainSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "build-inputs.json"),
    JSON.stringify(
      {
        runtime: runtime.metafile?.inputs,
        release: release.metafile?.inputs,
      },
      null,
      2,
    ),
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-fs-watch-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeWatchFacet",
        compatibilityDate: "2026-10-18",
        compatibilityFlags: ["nodejs_compat"],
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

const releaseSource = `import fs from 'node:fs';
import promises from 'node:fs/promises';
import {watch as chokidarWatch} from 'chokidar';

function deadline(operation) {
  let timer;
  return Promise.race([operation,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('watcher milestone timed out')),2000);
  })]).finally(()=>clearTimeout(timer));
}
function event(watcher, name, path) {
  return new Promise((resolve,reject)=>{
    const onEvent=(actual,filename)=>{
      if(actual===name && filename===path){cleanup();resolve();}
    };
    const fail=error=>{cleanup();reject(error);};
    const cleanup=()=>{watcher.off('all',onEvent);watcher.off('error',fail);};
    watcher.on('all',onEvent);watcher.on('error',fail);
  });
}
export async function check(call) {
  const checks={};
  const root='/watch-'+call;
  let rootListener;
  try {
    const rootChanged=new Promise(resolve=>{
      rootListener=(current,previous)=>resolve(current.ino===previous.ino && current.mtimeMs>previous.mtimeMs);
      fs.watchFile('/',{interval:5},rootListener);
    });
    fs.mkdirSync(root);
    checks.rootWatchFile=await deadline(rootChanged);
  } finally {fs.unwatchFile('/',rootListener);}
  fs.writeFileSync(root+'/entry','before');
  let statListener;
  try {
    const statChanged = new Promise(resolve=>{
      statListener=(current,previous)=>resolve(current.size===5n && previous.size===6n);
      fs.watchFile(root+'/entry',{interval:5,bigint:true},statListener);
    });
    fs.writeFileSync(root+'/entry','after');
    checks.watchFile=await deadline(statChanged);
  } finally {fs.unwatchFile(root+'/entry',statListener);}

  const watcher=fs.watch(root);
  try {
    const mutation=new Promise((resolve,reject)=>{
      watcher.once('error',reject);
      watcher.on('change',(type,filename)=>{
        if(type==='rename' && filename==='added')resolve(true);
      });
    });
    fs.writeFileSync(root+'/added','new');
    checks.watch=await deadline(mutation);
  } finally {
    const closed=new Promise(resolve=>watcher.once('close',()=>resolve(true)));
    watcher.close(); checks.close=await deadline(closed);
  }
  fs.mkdirSync(root+'/first');
  fs.mkdirSync(root+'/second/nested',{recursive:true});
  fs.symlinkSync(root+'/second/nested',root+'/first/link');
  const traversed=fs.watch(root+'/first/link/..');
  try {
    const traversedChange=new Promise((resolve,reject)=>{
      traversed.once('error',reject);
      traversed.on('change',(type,name)=>{if(type==='rename' && name==='expected')resolve(true);});
    });
    fs.writeFileSync(root+'/second/expected','yes');
    checks.symlinkTraversal=await deadline(traversedChange);
  } finally {traversed.close();}
  const iterator=promises.watch(root);
  try {
    const next=iterator.next();
    fs.writeFileSync(root+'/iterated','new');
    const result=await deadline(next);
    checks.promiseWatch=result.done===false && result.value.eventType==='rename' && result.value.filename==='iterated';
  } finally {await iterator.return();}

  const observed=[];
  const tree=chokidarWatch(root,{usePolling:true,interval:5,binaryInterval:5,atomic:false,ignoreInitial:true,ignorePermissionErrors:true});
  tree.on('all',(type,path)=>observed.push({type,path}));
  try {
    await deadline(new Promise((resolve,reject)=>{tree.once('ready',resolve);tree.once('error',reject);}));
    checks.chokidarReady=true;
    const file=root+'/chokidar';
    let next=event(tree,'add',file); fs.writeFileSync(file,'one'); await deadline(next);
    next=event(tree,'change',file); fs.writeFileSync(file,'longer'); await deadline(next);
    next=event(tree,'unlink',file); fs.unlinkSync(file); await deadline(next);
    checks.chokidarMutations=['add','change','unlink'].every(type=>observed.some(row=>row.type===type && row.path===file));
  } finally {await tree.close();checks.chokidarClosed=true;}
  return {checks,observed};
}`;

const mainSource = `import {DurableObject} from 'cloudflare:workers';
import {createFacetSqliteStorage,KernelFileSystem,createNodeFs,createNodePath,bootNodeRelease} from './runtime.js';
export class NodeWatchFacet extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_watch_calls(n INTEGER)');
    let time=1800000000000000000n;
    const storage=createFacetSqliteStorage(ctx.storage,()=>time+=1000000n);
    const filesystem=new KernelFileSystem({mounts:[{path:'/',storage}],cwd:'/'});
    const modules=createNodeFs(filesystem);
    const path=createNodePath(filesystem);
    this.loaded=bootNodeRelease({modules:{...modules,path,'path/posix':path.posix}},()=>import('./release.js'));
    this.serial=Promise.resolve();
  }
  fetch(request){
    const path=new URL(request.url).pathname;
    if(path!=='/status' && path!=='/again')return new Response('unknown route',{status:404});
    const response=this.serial.then(()=>this.check());
    this.serial=response.catch(()=>{});
    return response;
  }
  async check(){
    this.ctx.storage.sql.exec('INSERT INTO node_watch_calls VALUES(1)');
    const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM node_watch_calls').one().n;
    try {
      const {release}=await this.loaded;
      const result=await release.check(calls);
      const ok=Object.values(result.checks).every(value=>value===true);
      return Response.json({ok,calls,...result,note:'Kernel filesystem watchers and Chokidar only; no official Claude or Codex replay.'},{status:ok?200:500});
    }catch(error){return Response.json({ok:false,calls,error:String(error),stack:error.stack},{status:500});}
  }
}`;
