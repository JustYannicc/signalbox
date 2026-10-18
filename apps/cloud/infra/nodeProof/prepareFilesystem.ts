// @effect-diagnostics nodeBuiltinImport:off - prepares isolated facet filesystem and context proof modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";

export async function prepareNodeFilesystemProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const root = NodeURL.fileURLToPath(new URL("../../src/", import.meta.url));
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "filesystem-runtime.ts",
      resolveDir: root,
      contents: `export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
export {bootNodeRelease} from './isolate/NodeBootstrap.ts';
export {createNodeFs} from './isolate/NodeFs.ts';
export {createNodeProcess} from './isolate/NodeProcess.ts';
export {createNodePath} from './isolate/NodePath.ts';
export {createNodeOs} from './isolate/NodeOs.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Filesystem proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);

  const layer = createNodeBridgeLayerModules([
    "fs",
    "fs/promises",
    "process",
    "path",
    "path/posix",
    "os",
  ]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "filesystem-release.js",
      contents: `import fs from 'node:fs';
import bareFs from 'fs';
import promises from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import posix from 'path/posix';
import os from 'node:os';
import {Buffer} from 'node:buffer';
const cjsFs = require('node:fs');
const cjsProcess = require('process');
export async function check(call) {
  const checks = {};
  checks.aliases = fs === bareFs && fs === cjsFs && fs.promises === promises && process === cjsProcess;
  fs.mkdirSync('/work/home', {recursive:true});
  fs.mkdirSync('/work/tmp', {recursive:true});
  process.chdir('/work');
  checks.context = process.cwd() === '/work' && path.resolve('file') === '/work/file' &&
    posix.resolve('file') === '/work/file' && os.homedir() === '/work/home' && os.tmpdir() === '/work/tmp';
  checks.pathAliases = path.posix.posix === path.posix && path.posix.win32 === path.win32 &&
    path.win32.posix === path.posix && path.win32.win32 === path.win32;
  checks.hostParallelism = os.availableParallelism() === 2;
  fs.mkdirSync('/work/a', {recursive:true});
  fs.mkdirSync('/work/b/sub', {recursive:true});
  try {fs.unlinkSync('/work/a/link');} catch(error) {if(error.code !== 'ENOENT') throw error;}
  fs.symlinkSync('/work/b/sub', '/work/a/link');
  fs.mkdirSync('/work/a/link/../new', {recursive:true});
  checks.recursiveMkdirPath = fs.statSync('/work/b/new').isDirectory() && !fs.existsSync('/work/a/new');
  fs.mkdirSync('/work/first/child', {recursive:true});
  fs.mkdirSync('/work/second/child', {recursive:true});
  fs.writeFileSync('/work/first/child/first', 'first');
  fs.writeFileSync('/work/second/child/second', 'second');
  process.chdir('/work/first');
  const openedDirectory = await promises.opendir('child');
  process.chdir('/work/second');
  const openedEntry = await openedDirectory.read();
  await openedDirectory.close();
  let missingDirectory;
  try {await promises.opendir('/work/missing');} catch(error) {missingDirectory = error;}
  checks.opendirOpenBoundary = openedEntry?.name === 'first' && missingDirectory?.code === 'ENOENT';
  process.chdir('/work');
  if (call === 1) fs.writeFileSync('persistent', 'first');
  checks.persistence = fs.readFileSync('persistent', 'utf8') === 'first';
  fs.writeFileSync('bytes', Buffer.from([0,255,1]));
  await promises.appendFile('bytes', Buffer.from([2,0,254]));
  checks.binaryAppend = (await promises.readFile('bytes')).equals(Buffer.from([0,255,1,2,0,254]));
  const fd = fs.openSync('bytes', 'r');
  const first = Buffer.alloc(2);
  const second = Buffer.alloc(2);
  fs.readSync(fd, first, 0, 2, null);
  fs.readSync(fd, second, 0, 2, null);
  checks.descriptorOffset = first.equals(Buffer.from([0,255])) && second.equals(Buffer.from([1,2]));
  fs.closeSync(fd);
  const handle = await promises.open('bytes', 'r');
  const positional = Buffer.alloc(2);
  const read = await handle.read(positional, 0, 2, 4);
  checks.fileHandle = read.bytesRead === 2 && positional.equals(Buffer.from([0,254]));
  await handle.close();
  let synchronous = true;
  const callback = new Promise((resolve, reject) => fs.readFile('bytes', (error, bytes) => {
    if(error) reject(error); else resolve(!synchronous && bytes.equals(Buffer.from([0,255,1,2,0,254])));
  }));
  synchronous = false;
  checks.callbackAsync = await callback;
  const streamed = [];
  for await (const chunk of fs.createReadStream('bytes')) streamed.push(chunk);
  checks.stream = Buffer.concat(streamed).equals(Buffer.from([0,255,1,2,0,254]));
  fs.writeFileSync('/work/range', 'abcdef');
  const fromStartFd = fs.openSync('/work/range', 'r');
  const fromStart = [];
  for await (const chunk of fs.createReadStream('/work/range', {fd:fromStartFd,end:1,autoClose:false})) fromStart.push(chunk);
  fs.closeSync(fromStartFd);
  const continuedFd = fs.openSync('/work/range', 'r');
  const consumed = Buffer.alloc(2);
  fs.readSync(continuedFd, consumed, 0, 2, null);
  const continued = [];
  for await (const chunk of fs.createReadStream('/work/range', {fd:continuedFd,end:3,autoClose:false})) continued.push(chunk);
  const afterEnd = Buffer.alloc(1);
  fs.readSync(continuedFd, afterEnd, 0, 1, null);
  fs.closeSync(continuedFd);
  checks.fdStreamEnd = Buffer.concat(fromStart).toString() === 'ab' && consumed.toString() === 'ab' &&
    Buffer.concat(continued).toString() === 'cd' && afterEnd.toString() === 'e';
  fs.writeFileSync('link-target', 'linked');
  try {fs.unlinkSync('symlink');} catch(error) {if(error.code !== 'ENOENT') throw error;}
  try {fs.unlinkSync('hardlink');} catch(error) {if(error.code !== 'ENOENT') throw error;}
  fs.symlinkSync('link-target', 'symlink');
  fs.linkSync('link-target', 'hardlink');
  checks.links = fs.readFileSync('symlink', 'utf8') === 'linked' &&
    fs.statSync('hardlink').ino === fs.statSync('link-target').ino && fs.lstatSync('symlink').isSymbolicLink();
  fs.writeFileSync('/work/callback-rm-file', 'file');
  const callbackRm = new Promise(resolve => fs.rm('/work/callback-rm-file', error => resolve(error === null)));
  checks.callbackRmOverload = await callbackRm && !fs.existsSync('/work/callback-rm-file');
  fs.mkdirSync('/work/callback-rm-directory');
  let callbackRmValidation;
  try {fs.rm('/work/callback-rm-directory', {recursive:true});} catch(error) {callbackRmValidation = error;}
  checks.callbackRmValidation = callbackRmValidation instanceof TypeError &&
    fs.statSync('/work/callback-rm-directory').isDirectory();
  fs.rmSync('/work/callback-rm-directory', {recursive:true});
  fs.mkdirSync('/work/rm-empty');
  let nonrecursiveDirectoryRm;
  let forcedDirectoryRm;
  try {fs.rmSync('/work/rm-empty');} catch(error) {nonrecursiveDirectoryRm = error;}
  try {fs.rmSync('/work/rm-empty', {force:true});} catch(error) {forcedDirectoryRm = error;}
  checks.rmRequiresRecursive = nonrecursiveDirectoryRm?.code === 'EISDIR' && forcedDirectoryRm?.code === 'EISDIR' &&
    fs.statSync('/work/rm-empty').isDirectory();
  fs.rmSync('/work/rm-empty', {recursive:true});
  const reviewRoot = '/work/r2-review';
  fs.rmSync(reviewRoot, {recursive:true,force:true});
  fs.mkdirSync(reviewRoot + '/a', {recursive:true});
  fs.mkdirSync(reviewRoot + '/b/sub', {recursive:true});
  fs.symlinkSync(reviewRoot + '/b/sub', reviewRoot + '/a/link');
  fs.mkdirSync(reviewRoot + '/a/tree');
  fs.mkdirSync(reviewRoot + '/b/tree');
  fs.writeFileSync(reviewRoot + '/a/tree/same', 'keep');
  fs.writeFileSync(reviewRoot + '/b/tree/same', 'remove');
  let aliasRmError;
  try {fs.rmSync(reviewRoot + '/a/link/../tree', {recursive:true});} catch(error) {aliasRmError = error;}
  const aliasRm = aliasRmError === undefined && fs.readFileSync(reviewRoot + '/a/tree/same', 'utf8') === 'keep' &&
    !fs.existsSync(reviewRoot + '/b/tree');
  fs.mkdirSync(reviewRoot + '/a/items');
  fs.mkdirSync(reviewRoot + '/b/items');
  fs.writeFileSync(reviewRoot + '/a/items/entry', 'file');
  fs.mkdirSync(reviewRoot + '/b/items/entry');
  fs.mkdirSync(reviewRoot + '/a/items/folder');
  fs.writeFileSync(reviewRoot + '/b/items/folder', 'file');
  fs.mkdirSync(reviewRoot + '/a/items/link');
  fs.symlinkSync(reviewRoot + '/b/items/folder', reviewRoot + '/b/items/link');
  const aliasItems = reviewRoot + '/a/link/../items';
  const listed = fs.readdirSync(aliasItems, {withFileTypes:true});
  const listedByName = new Map(listed.map(entry => [String(entry.name), entry]));
  const readdirTypes = listedByName.get('entry')?.isDirectory() && listedByName.get('folder')?.isFile() &&
    listedByName.get('link')?.isSymbolicLink();
  const reviewDirectory = await promises.opendir(aliasItems);
  const opened = [];
  for await (const entry of reviewDirectory) opened.push(entry);
  const openedByName = new Map(opened.map(entry => [String(entry.name), entry]));
  const opendirMetadata = opened.length === 3 && opened.every(entry =>
    entry.parentPath === aliasItems && entry.path === aliasItems);
  const opendirTypes = openedByName.get('entry')?.isDirectory() && openedByName.get('folder')?.isFile() &&
    openedByName.get('link')?.isSymbolicLink();
  checks.symlinkDotDotChildren = aliasRm && readdirTypes && opendirMetadata && opendirTypes;
  fs.rmSync(reviewRoot, {recursive:true,force:true});
  const invalidCallbacks = [null, 1, {}];
  let callbacksRejectedSynchronously = true;
  for (const [index, invalidCallback] of invalidCallbacks.entries()) {
    const victim = '/work/callback-victim-' + index;
    fs.writeFileSync(victim, 'keep');
    let failure;
    try {Reflect.apply(fs.unlink, fs, [victim, invalidCallback]);} catch(error) {failure = error;}
    callbacksRejectedSynchronously = callbacksRejectedSynchronously && failure instanceof TypeError &&
      fs.readFileSync(victim, 'utf8') === 'keep';
  }
  await Promise.resolve();
  checks.callbackValidation = callbacksRejectedSynchronously && invalidCallbacks.every((_, index) =>
    fs.existsSync('/work/callback-victim-' + index) &&
    fs.readFileSync('/work/callback-victim-' + index, 'utf8') === 'keep');
  for (const [index] of invalidCallbacks.entries()) {
    fs.rmSync('/work/callback-victim-' + index, {force:true});
  }
  let missing;
  try {await promises.readFile('missing');} catch(error) {missing = error;}
  checks.typedError = missing?.code === 'ENOENT' && missing.path === 'missing' && typeof missing.syscall === 'string';
  let unsupported;
  try {fs.watch('bytes');} catch(error) {unsupported = error;}
  checks.unsupported = unsupported?.code === 'ENOTSUP';
  fs.mkdirSync('anchor', {recursive:true});
  process.chdir('/work/anchor');
  fs.renameSync('/work/anchor', '/work/renamed');
  checks.renamedCwd = process.cwd() === '/work/renamed' && path.resolve('leaf') === '/work/renamed/leaf';
  fs.mkdirSync('/other', {recursive:true});
  fs.renameSync('/work/renamed', '/other/moved');
  let stale;
  try {process.cwd();} catch(error) {stale = error;}
  checks.staleCwd = stale?.code === 'ESTALE';
  let staleNestedPath;
  try {path.posix.posix.resolve('leaf');} catch(error) {staleNestedPath = error;}
  checks.staleNestedPath = staleNestedPath?.code === 'ESTALE';
  process.chdir('/');
  fs.rmdirSync('/other/moved');
  return {ok:Object.values(checks).every(Boolean),checks};
}`,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "filesystem-bridge-facades",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(layer, args.path)) return { path: args.path, namespace: "bridge" };
            if (args.path === "node:buffer") return { path: args.path, external: true };
            throw new Error(`Unexpected filesystem release import: ${args.path}`);
          });
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => ({
            contents: layer[args.path]!,
            loader: "js",
          }));
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("Filesystem release bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);
  const main = `import {DurableObject} from 'cloudflare:workers';
import {PassThrough} from 'node:stream';
import {createFacetSqliteStorage,KernelFileSystem,bootNodeRelease,createNodeFs,createNodeProcess,createNodePath,createNodeOs} from './runtime.js';
export class NodeFilesystemFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_filesystem_calls(n INTEGER)');
    const storage = createFacetSqliteStorage(ctx.storage, () => 1800000000000000000n);
    const filesystem = new KernelFileSystem({mounts:[{path:'/',storage}],cwd:'/'});
    const envVars = {HOME:'/work/home',TMPDIR:'/work/tmp'};
    const identity = {version:'v24.18.0',versions:{node:'24.18.0'},platform:'linux',arch:'x64',
      homedir:'/work/home',tmpdir:'/work/tmp',availableParallelism:2,pid:1,ppid:0,execPath:'/bin/node',argv0:'node',argv:['node','/release.js']};
    const process = createNodeProcess({filesystem,env:envVars,identity,
      streams:{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}});
    const path = createNodePath(filesystem);
    this.ready = bootNodeRelease({modules:{...createNodeFs(filesystem),process,
      path,'path/posix':path.posix,os:createNodeOs({env:envVars,identity})}}, () => import('./release.js'));
  }
  async fetch() {
    try {
      const {release} = await this.ready;
      this.ctx.storage.sql.exec('INSERT INTO node_filesystem_calls VALUES(1)');
      const calls = this.ctx.storage.sql.exec('SELECT count(*) AS n FROM node_filesystem_calls').one().n;
      const result = await release.check(calls);
      return Response.json({...result,calls,note:'Filesystem and context only. Stdio are fixture streams; lazy hydration, child programs and rg are outside this proof.'}, {status:result.ok?200:500});
    } catch(error) {return Response.json({ok:false,error:String(error),stack:error.stack}, {status:500});}
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-filesystem-context-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeFilesystemFacet",
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
