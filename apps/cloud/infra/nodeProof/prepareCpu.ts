// @effect-diagnostics nodeBuiltinImport:off - Builds proof modules without running a native probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

import { createNodeBridgeLayerModules } from "../../src/isolate/NodeBridge.ts";
import { cpuPollReactor, cpuReturnReactor, cpuWasmCheckMethods } from "./prepareCpuWasm.ts";

export async function prepareNodeCpuProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "cpu-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {KernelCpuAccounting} from './kernel/KernelCpuAccounting.ts';
export {KernelProgramHost} from './kernel/KernelProgramHost.ts';
export {KernelProgramRegistry,ABI_VERSION,callKernel} from './kernel/KernelAbi.ts';
export {runCurrentKernelCpuAsyncSystemImport,runCurrentKernelCpuAwaitableSystemImport} from './kernel/KernelCpuExecution.ts';
export {AgentOsDescriptorHost} from './kernel/AgentOsDescriptorHost.ts';
export {KernelWakeRegistry} from './kernel/KernelWakeRegistry.ts';
export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
export {createKernelAsyncWasi} from './kernel/KernelWasi.ts';
export {createNodeProcess} from './isolate/NodeProcess.ts';
export {bootNodeRelease} from './isolate/NodeBootstrap.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("CPU proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  await NodeFSP.writeFile(NodePath.join(destination, "return.wasm"), cpuReturnReactor);
  const layer = createNodeBridgeLayerModules(["process"]);
  const release = await Esbuild.build({
    stdin: {
      sourcefile: "cpu-release.js",
      contents: `import processDefault,{cpuUsage} from 'node:process';
import * as processNamespace from 'process';
const commonJsProcess=require('process');
export function read(previous) {
  return {value:cpuUsage(previous),identity:processDefault===commonJsProcess &&
    processNamespace.default===commonJsProcess && globalThis.process===commonJsProcess &&
    cpuUsage===processDefault.cpuUsage};
}`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "cpu-proof-bridge",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.path in layer ? { path: args.path, namespace: "bridge" } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "bridge" }, (args) => {
            const contents = layer[args.path];
            if (contents === undefined) throw new Error("Unknown CPU proof bridge module");
            return { contents, loader: "js" };
          });
        },
      },
    ],
  });
  const releaseSource = release.outputFiles?.[0]?.text;
  if (!releaseSource) throw new Error("CPU proof release bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "release.js"), releaseSource);
  await NodeFSP.writeFile(NodePath.join(destination, "poll.wasm"), cpuPollReactor);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import {DurableObject} from 'cloudflare:workers';
import * as NativeProcess from 'node:process';
import {PassThrough} from 'node:stream';
import pollReactor from './poll.wasm';
import returnReactor from './return.wasm';
import {KernelCpuAccounting,KernelProgramHost,KernelProgramRegistry,KernelWakeRegistry,
  createNodeProcess,bootNodeRelease,createFacetSqliteStorage,KernelFileSystem,createKernelAsyncWasi,
  runCurrentKernelCpuAsyncSystemImport,runCurrentKernelCpuAwaitableSystemImport,
  AgentOsDescriptorHost,ABI_VERSION,callKernel} from './runtime.js';

const readClock=NativeProcess.hrtime.bigint.bind(NativeProcess.hrtime);
const equal=(a,b)=>a.user===b.user && a.system===b.system;
function assert(value,message) {if(!value)throw new Error(message);}
function work() {
  let checksum=123456789;
  for(let i=0;i<1000000;i++)checksum=(Math.imul(checksum^i,1664525)+1013904223)|0;
  return checksum;
}
function hostContext(pid,cpuAccounting) {
  return {filesystem:{cwd:'/',chdir(){}},env:{},cpuAccounting,
    identity:{version:'v22.12.0',versions:{node:'22.12.0'},platform:'linux',arch:'x64',
      homedir:'/',tmpdir:'/tmp',pid,ppid:0,execPath:'/node',argv0:'node',argv:['node']},
    streams:{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}};
}
export class ProcessCpuFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.core=new KernelCpuAccounting(readClock);
    this.wakes=new KernelWakeRegistry();
    this.host=new KernelProgramHost({registry:new KernelProgramRegistry(),wakes:this.wakes,
      cpuAccounting:this.core});
    this.root=this.host.cpuExecution.root;
    this.process=createNodeProcess(hostContext(1,this.root));
    this.calls=0;this.serial=Promise.resolve();
    this.ready=bootNodeRelease({modules:{process:this.process},globals:{process:this.process}},
      ()=>import('./release.js'));
  }
  fetch(request) {
    const path=new URL(request.url).pathname;
    if(path!=='/status' && path!=='/again')return new Response('Not found',{status:404});
    const response=this.serial.then(()=>this.check());
    this.serial=response.catch(()=>{});
    return response;
  }
  async check() {
    const checks={};
    try {
      const {release}=await this.ready;
      const initial=release.read();
      checks.identity=initial.identity;
      let detached,leaveRoot,blocked,afterResume,checksum;
      const registered=this.wakes.register(()=>()=>{});
      assert(registered.status==='ok','Wake registration failed');
      const token=registered.value;
      this.root.run(()=>{
        leaveRoot=this.root.enterUser();
        checksum=work();
        detached=Promise.resolve().then(async()=>{
          checks.detachedIdentity=this.host.cpuExecution.current()===this.root;
          const waiting=this.wakes.wait(token);
          blocked=release.read().value;
          await waiting;
          afterResume=release.read().value;
          checksum^=work();
          leaveRoot();
        });
      });
      await Promise.resolve();
      assert(blocked,'Detached work did not reach its wake wait');
      const idleStart=readClock();
      await new Promise(resolve=>setTimeout(resolve,10));
      const idleEnd=readClock();
      checks.blockedWaitExcluded=equal(blocked,release.read().value);
      this.wakes.signal(token);
      await detached;
      checks.resumedMonotonic=afterResume.user>=blocked.user && afterResume.system>=blocked.system;
      const beforeChild=release.read().value;
      const child=this.host.cpuExecution.forProcess(2);
      child.runUser(()=>{checksum^=work();});
      checks.processIsolation=equal(beforeChild,release.read().value);
      const childUsage=child.snapshot();
      child.stop();
      this.root.runSystem(()=>{checksum^=work();});
      await this.root.run(()=>this.checkWasm(checks));
      await this.checkWasmSiblings(checks);
      await this.checkWasmClockFailures(checks);
      await this.checkAsyncRejectionFailure(checks);
      await this.checkInlineRejectionFailure(checks);
      await this.checkDescriptorWaits(checks);
      const final=release.read().value;
      checks.monotonic=final.user>=initial.value.user && final.system>=initial.value.system;
      const difference=release.read(initial.value).value;
      checks.previousDifference=difference.user===final.user-initial.value.user &&
        difference.system===final.system-initial.value.system;
      const guestClock=this.process.hrtime.bigint;
      try {
        this.process.hrtime.bigint=()=>-1n;
        checks.privateCapturedClock=equal(final,release.read().value);
      } finally {this.process.hrtime.bigint=guestClock;}
      checks.microseconds=Number.isSafeInteger(final.user) && final.user>=0 &&
        Number.isSafeInteger(final.system) && final.system>=0;
      if(this.previous)checks.acrossRequests=final.user>=this.previous.user && final.system>=this.previous.system;
      this.previous=final;this.calls++;
      const ok=Object.values(checks).every(Boolean);
      return Response.json({ok,calls:this.calls,checks,initial:initial.value,final,difference,checksum,
        childNanoseconds:{user:String(childUsage.userNs),system:String(childUsage.systemNs)},
        observedBlockedClockDeltaNs:String(idleEnd-idleStart),
        note:'Logical kernel accounting at host clock resolution; native OS CPU and official release boot are separate.'},
        {status:ok?200:500});
    } catch(error) {
      return Response.json({ok:false,checks,error:String(error),stack:error.stack},{status:500});
    }
  }
${cpuWasmCheckMethods}
}
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-logical-process-cpu-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "ProcessCpuFacet",
        modules: {
          ...Object.fromEntries(
            ["main.js", "runtime.js", "release.js"].map((name) => [
              name,
              { path: name, type: "js" },
            ]),
          ),
          "poll.wasm": { path: "poll.wasm", type: "wasm" },
          "return.wasm": { path: "return.wasm", type: "wasm" },
        },
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}
