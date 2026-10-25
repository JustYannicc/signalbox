// @effect-diagnostics nodeBuiltinImport:off - Builds proof modules without running a native probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

/** The coordinator runs the frozen output in local and deployed Durable Objects. */
export async function prepareNodeHydrationProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "hydration-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {createFacetFilePersistence} from './kernel/FacetFilePersistence.ts';
export {KernelWakeRegistry} from './kernel/KernelAbi.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
export {createNodeFs} from './isolate/NodeFs.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Hydration proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import {createFacetFilePersistence,KernelWakeRegistry,KernelFileSystem,createNodeFs} from './runtime.js';
const deferred = () => Promise.withResolvers();
export class NodeHydrationFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.sources = new Map();
    this.requests = [];
    this.wakes = new KernelWakeRegistry();
    this.at = {repository:'fixture',fork:'proof',commit:'base'};
    this.persistence = createFacetFilePersistence(ctx.storage, () => 1800000000000000000n, {
      wakes:this.wakes,
      ports:{
        commits:{async commit(){return {status:'error',error:{code:'NOT_YET',message:'Not part of this proof'}};}},
        hydration:{fetch:async(input) => {
          this.requests.push(input);
          const source = this.sources.get(input.paths[0]);
          if(!source) return {status:'error',error:{code:'NOT_FOUND',message:'Missing fixture source'}};
          source.started.resolve();
          await source.release.promise;
          if(source.failure) return {status:'error',error:source.failure};
          return {status:'ok',value:[{path:input.paths[0],chunks:(async function*(){yield source.bytes;})()}]};
        }},
      },
    });
    let stdinRead = false;
    this.stdout = '';
    this.filesystem = new KernelFileSystem({mounts:[{path:'/',storage:this.persistence.storage}],cwd:'/',
      stdio:[{readInto:target=>{if(stdinRead)return 0;target[0]=73;stdinRead=true;return 1;}},
        {write:bytes=>{this.stdout+=Buffer.from(bytes.subarray(0,1)).toString();return 1;}},{}]});
    this.fs = createNodeFs(this.filesystem, undefined, this.persistence.runLeaf).fs;
    this.serial = Promise.resolve();
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_hydration_calls(n INTEGER)');
  }
  mark(path,text,delayed=false) {
    const bytes = new TextEncoder().encode(text);
    const source = {bytes,started:deferred(),release:deferred(),failure:null};
    if(!delayed) source.release.resolve();
    this.sources.set(path,source);
    const storage = this.persistence.storage;
    const inode = storage.create(storage.root,path.slice(1),{type:'file',exclusive:true});
    storage.truncate(inode,BigInt(bytes.byteLength));
    this.persistence.markUnhydrated({inode,path,at:this.at,size:BigInt(bytes.byteLength)});
    return {inode,...source};
  }
  fetch() {
    const response = this.serial.then(()=>this.check());
    this.serial = response.catch(()=>{});
    return response;
  }
  async check() {
    const checks = {};
    const {fs,filesystem,persistence} = this;
    this.ctx.storage.sql.exec('INSERT INTO node_hydration_calls VALUES(1)');
    const calls = this.ctx.storage.sql.exec('SELECT count(*) AS n FROM node_hydration_calls').one().n;
    const prefix = '/call-'+calls+'-';
    try {
      const count = this.requests.length;
      const lazy = this.mark(prefix+'lazy','shared bytes',true);
      let syncError;
      try {fs.readFileSync(prefix+'lazy');}catch(error){syncError=error;}
      checks.lazySync = syncError?.code==='EAGAIN' && fs.statSync(prefix+'lazy').size===12 && this.requests.length===count;
      const handles = await Promise.all([fs.promises.open(prefix+'lazy'),fs.promises.open(prefix+'lazy')]);
      const controller = new AbortController();
      const reason = new Error('one caller left');
      const first = handles[0].readFile({signal:controller.signal}).catch(error=>error);
      const second = handles[1].readFile('utf8');
      await lazy.started.promise;
      checks.sharedWaiters = this.wakes.size===2 && this.requests.length===count+1;
      controller.abort(reason);
      const abortError = await first;
      checks.cancelOwnWaiter = abortError.name==='AbortError' && abortError.code==='ABORT_ERR' && abortError.cause===reason && this.wakes.size===1 && !this.requests.at(-1).signal.aborted;
      lazy.release.resolve();
      checks.sharedFetchSurvives = await second==='shared bytes' && this.wakes.size===0;
      await Promise.all(handles.map(handle=>handle.close()));
      let callbackCalls = 0;
      this.mark(prefix+'callback','callback bytes');
      const callbackValue = await new Promise((resolve,reject)=>fs.readFile(prefix+'callback','utf8',(error,value)=>{
        callbackCalls++;if(error)reject(error);else resolve(value);
      }));
      checks.callbackHydration = callbackValue==='callback bytes' && callbackCalls===1;
      const failed = this.mark(prefix+'failed','recovered');
      const portFailure = {code:'NOT_FOUND',message:'source unavailable'};
      this.sources.get(prefix+'failed').failure = portFailure;
      const error1 = await fs.promises.readFile(prefix+'failed').catch(error=>error);
      let cause = error1;
      while(cause?.cause) cause=cause.cause;
      const beforeCached = this.requests.length;
      const error2 = await fs.promises.readFile(prefix+'failed').catch(error=>error);
      checks.failureCached = error1.code==='NOT_FOUND' && error2.code==='NOT_FOUND' && cause.persistenceError===portFailure && this.requests.length===beforeCached;
      this.sources.get(prefix+'failed').failure = null;
      persistence.retryHydration(failed.inode);
      checks.explicitRetry = await fs.promises.readFile(prefix+'failed','utf8')==='recovered' && this.requests.length===beforeCached+1;
      const gate = this.mark(prefix+'gate','g',true);
      const gateFd = fs.openSync(prefix+'gate');
      fs.writeFileSync(prefix+'target','old');
      const originalWrite = filesystem.write.bind(filesystem);
      const originalOpen = filesystem.open.bind(filesystem);
      const originalClose = filesystem.close.bind(filesystem);
      let writes=0,opens=0,closes=0;
      filesystem.open = (...args)=>{opens++;return originalOpen(...args);};
      filesystem.close = (...args)=>{closes++;return originalClose(...args);};
      filesystem.write = (fd,bytes,position)=>{
        writes++;
        if(writes===1)return originalWrite(fd,bytes.subarray(0,2),position);
        filesystem.read(gateFd,new Uint8Array(1),0n);
        return originalWrite(fd,bytes,position);
      };
      try {
        const writing = fs.promises.writeFile(prefix+'target','abcdef');
        await gate.started.promise;
        gate.release.resolve();
        await writing;
        checks.exactWriteLeaf = writes===3 && opens===1 && closes===1;
      } finally {filesystem.write=originalWrite;filesystem.open=originalOpen;filesystem.close=originalClose;gate.release.resolve();}
      fs.closeSync(gateFd);
      checks.aggregateBytes = fs.readFileSync(prefix+'target','utf8')==='abcdef';
      const streamSource = this.mark(prefix+'stream','stream bytes',true);
      const stream = fs.createReadStream(prefix+'stream',{highWaterMark:1});
      const opened = new Promise(resolve=>stream.once('open',resolve));
      const closed = new Promise(resolve=>stream.once('close',resolve));
      let emitted = 0;
      stream.on('data',bytes=>{emitted+=bytes.length;});
      await opened;
      await streamSource.started.promise;
      const otherHandle = await fs.promises.open(prefix+'stream');
      const other = otherHandle.readFile('utf8');
      stream.destroy();
      await closed;
      checks.streamCancelled = stream.fd===null && emitted===0 && this.wakes.size===1 && !this.requests.at(-1).signal.aborted;
      streamSource.release.resolve();
      checks.streamSharedFetch = await other==='stream bytes' && this.wakes.size===0;
      await otherHandle.close();
      const stdoutBefore = this.stdout;
      await new Promise((resolve,reject)=>fs.write(1,'XY',(error,count)=>error?reject(error):resolve(count)));
      checks.stdioWrites = this.stdout===stdoutBefore+'XY';
      const ok = Object.values(checks).every(Boolean);
      return Response.json({ok,calls,checks,note:'NodeFS hydration only; no full runtime turn proof.'},{status:ok?200:500});
    } catch(error) {
      for(const source of this.sources.values()) source.release.resolve();
      return Response.json({ok:false,calls,checks,error:String(error),stack:error.stack},{status:500});
    }
  }
}
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-fs-hydration-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeHydrationFacet",
        modules: Object.fromEntries(
          ["main.js", "runtime.js"].map((name) => [name, { path: name, type: "js" }]),
        ),
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}
