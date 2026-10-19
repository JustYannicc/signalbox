// @effect-diagnostics nodeBuiltinImport:off - Builds isolated SQL filesystem proof modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

export async function prepareNodeGlobProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const layer = createNodeBridgeLayerModules(["fs", "fs/promises"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "glob-release.js",
      contents: `import promises, {glob} from 'node:fs/promises';
import * as namespace from 'fs/promises';
import fs from 'node:fs';
const cjs = require('node:fs/promises');
const collect = async iterator => {const values=[];for await(const value of iterator)values.push(value);return values;};
const same = (actual,expected) => JSON.stringify([...actual].sort())===JSON.stringify([...expected].sort());
export async function check(host,kernel,calls,leafCount) {
  const checks={};
  const rows={};
  checks.importIdentity=promises===host && namespace.default===host && cjs===host &&
    glob===host.glob && fs.promises===host;
  const cwd='/work/tree';
  rows.patterns=await collect(glob('src/**/*.{js,ts}',{cwd}));
  checks.patterns=same(rows.patterns,['src/a.js','src/b.ts','src/deep/c.js']);
  rows.patternArray=await collect(glob(['src/**/*.js','src/a.js'],{cwd}));
  checks.patternArrayDeduplicates=same(rows.patternArray,['src/a.js','src/deep/c.js']);
  rows.classes=await collect(glob('src/[ab].@(js|ts)',{cwd}));
  checks.classesAndExtglob=same(rows.classes,['src/a.js','src/b.ts']);
  checks.defaultDotExclusion=(await collect(glob('src/*',{cwd}))).every(path=>!path.includes('.hidden'));
  checks.explicitDotPattern=same(await collect(glob('src/.*',{cwd})),['src/.hidden']);
  rows.excludeArray=await collect(glob('**/*.js',{cwd,exclude:['node_modules/**','.git/**','src/deep/**']}));
  checks.excludeArray=same(rows.excludeArray,['src/a.js']);
  const stringArguments=[];
  rows.excludeString=await collect(glob('**/*.js',{cwd,exclude:value=>{
    stringArguments.push(value);return value==='node_modules' || value==='.git' || value==='src/deep';
  }}));
  checks.excludeCallbackStrings=stringArguments.length>0 && stringArguments.every(value=>typeof value==='string') &&
    same(rows.excludeString,['src/a.js']);
  const direntArguments=[];
  rows.dirents=(await collect(glob('**/*.js',{cwd,withFileTypes:true,exclude:entry=>{
    direntArguments.push({name:entry.name,parentPath:entry.parentPath,directory:entry.isDirectory()});
    return entry.name==='node_modules' || entry.name==='.git';
  }}))).map(entry=>({name:entry.name,parentPath:entry.parentPath,file:entry.isFile(),directory:entry.isDirectory(),symlink:entry.isSymbolicLink()}));
  checks.withFileTypes=same(rows.dirents.map(entry=>entry.parentPath+'/'+entry.name),
    ['/work/tree/src/a.js','/work/tree/src/deep/c.js']) && rows.dirents.every(entry=>entry.file && !entry.directory && !entry.symlink);
  checks.excludeCallbackDirents=direntArguments.some(entry=>entry.name==='node_modules' && entry.directory) &&
    direntArguments.every(entry=>typeof entry.name==='string' && typeof entry.parentPath==='string');
  checks.cwdUrl=same(await collect(glob('*.js',{cwd:new URL('file:///work/tree/src/')})),['a.js']);
  checks.absolutePattern=same(await collect(glob('/work/tree/src/*.js',{cwd:'/'})),['/work/tree/src/a.js']);
  kernel.chdir('/work/tree/src');
  checks.kernelCwd=same(await collect(glob('*.js')),['a.js']);
  kernel.chdir('/work/tree');
  const before=leafCount();
  const lazy=glob('lazy/*.js');
  checks.noEagerSyscalls=leafCount()===before;
  fs.writeFileSync(cwd+'/lazy/created-'+calls+'.js','late');
  checks.lazySeesLaterFile=(await collect(lazy)).includes('lazy/created-'+calls+'.js');
  fs.unlinkSync(cwd+'/lazy/created-'+calls+'.js');
  const early=glob('src/**/*',{cwd});
  const first=await early.next();
  await early.return();
  const stoppedAt=leafCount();
  await Promise.resolve();
  checks.earlyReturn=!first.done && (await early.next()).done && leafCount()===stoppedAt;
  rows.symlink=(await collect(glob('linked',{cwd,withFileTypes:true}))).map(entry=>({name:entry.name,symlink:entry.isSymbolicLink()}));
  checks.symlinkDirent=rows.symlink.length===1 && rows.symlink[0].name==='linked' && rows.symlink[0].symlink;
  checks.explicitSymlinkTraversal=same(await collect(glob('linked/*.js',{cwd})),['linked/a.js']);
  checks.recursiveSymlinkCycle=(await collect(glob('cycle/**/*.js',{cwd}))).length===0;
  checks.missingIsEmpty=(await collect(glob('missing/**/*.js',{cwd}))).length===0;
  const invalid=[];
  for(const [pattern,options] of [[42,{}],['*',{cwd:42}],['*',{withFileTypes:'yes'}],['*',{exclude:42}]]) {
    try {await collect(glob(pattern,options));invalid.push(null);}catch(error){invalid.push(error.code);}
  }
  rows.invalid=invalid;
  checks.nodeValidation=JSON.stringify(invalid)===JSON.stringify(['ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_TYPE',null,'ERR_INVALID_ARG_TYPE']);
  checks.asyncKernelOperations=leafCount()>before;
  checks.persistedFixture=fs.readFileSync(cwd+'/persistent','utf8')==='SQL glob fixture';
  const gone='/work/gone-'+calls;
  fs.mkdirSync(gone);
  kernel.chdir(gone);
  fs.rmdirSync(gone);
  try {
    checks.absoluteCwdAfterRemoval=same(await collect(glob('*.js',{cwd:cwd+'/src',exclude:[]})),['a.js']);
    checks.absoluteUrlCwdAfterRemoval=same(await collect(glob('*.js',{cwd:new URL('file:///work/tree/src/'),exclude:[]})),['a.js']);
    checks.absoluteMissingCwdAfterRemoval=(await collect(glob('no-match',{cwd:cwd+'/src'}))).length===0;
  } finally {kernel.chdir(cwd);}
  return {checks,rows};
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "glob-bridge",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.path in layer ? { path: args.path, namespace: "bridge" } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => {
            const contents = layer[args.path];
            if (contents === undefined) throw new Error("Unknown filesystem bridge module");
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("Glob release proof bundle was empty");
  const worker = await Esbuild.build({
    stdin: {
      sourcefile: "glob-worker.js",
      resolveDir: import.meta.dirname,
      contents: `import {DurableObject} from 'cloudflare:workers';
import {createFacetSqliteStorage} from '../../src/kernel/FacetSqliteStorage.ts';
import {KernelFileSystem} from '../../src/kernel/KernelFileSystem.ts';
import {createNodeFs} from '../../src/isolate/NodeFs.ts';
import {installNodePersonality} from '../../src/isolate/NodeBootstrap.ts';
export class NodeGlobFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    const storage=createFacetSqliteStorage(ctx.storage,()=>1800000000000000000n);
    try {storage.posix.get(storage.root);}
    catch(error) {if(error.code!=='ENOTSUP')throw error;storage.posix.initialize(storage.root,{mode:0o755,uid:1000,gid:1000});}
    this.kernel=new KernelFileSystem({mounts:[{path:'/',storage}],cwd:'/',
      posix:{credentials:{uid:1000,gid:1000,euid:1000,egid:1000},umask:0o022}});
    this.leaves=0;
    this.modules=createNodeFs(this.kernel,undefined,async operation=>{this.leaves++;await Promise.resolve();return operation();});
    installNodePersonality({modules:this.modules});
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_glob_proof_calls(n INTEGER)');
    this.serial=Promise.resolve();
  }
  fetch() {const result=this.serial.then(()=>this.check());this.serial=result.catch(()=>{});return result;}
  async check() {
    let phase='fixture';
    try {
      const fs=this.modules.fs;
      this.ctx.storage.sql.exec('INSERT INTO node_glob_proof_calls VALUES(1)');
      const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM node_glob_proof_calls').one().n;
      if(calls===1) {
        for(const path of ['src/deep','node_modules/dep','.git','lazy','cycle'])fs.mkdirSync('/work/tree/'+path,{recursive:true});
        for(const [path,text] of Object.entries({'src/a.js':'a','src/b.ts':'b','src/deep/c.js':'c','src/.hidden':'dot',
          'node_modules/dep/vendor.js':'vendor','.git/hook.js':'hook','persistent':'SQL glob fixture'}))fs.writeFileSync('/work/tree/'+path,text);
        fs.symlinkSync('src','/work/tree/linked');
        fs.symlinkSync('../cycle','/work/tree/cycle/back');
      }
      phase='guest';
      const guest=await import('./release.js');
      const result=await guest.check(this.modules['fs/promises'],this.kernel,calls,()=>this.leaves);
      const ok=Object.values(result.checks).every(Boolean);
      return Response.json({ok,calls,...result,leafCalls:this.leaves},{status:ok?200:500});
    } catch(error) {return Response.json({ok:false,phase,error:{name:error.name,code:error.code,message:error.message,stack:error.stack}},{status:500});}
  }
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    external: ["./release.js"],
    write: false,
  });
  const workerSource = worker.outputFiles?.[0]?.text;
  if (!workerSource) throw new Error("Glob worker proof bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "worker.js"), workerSource);
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-kernel-fs-glob-v1",
        mode: "facet",
        mainModule: "worker.js",
        entrypoint: "NodeGlobFacet",
        modules: {
          "worker.js": { path: "worker.js", type: "js" },
          "release.js": { path: "release.js", type: "js" },
        },
        paths: ["/glob", "/glob"],
      },
      null,
      2,
    ),
  );
}
