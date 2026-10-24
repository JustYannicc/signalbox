/** The facet owns files and descriptors; each compiler invocation gets a child Worker. */
export const TSC_PROBE_SOURCE = String.raw`import { DurableObject, RpcTarget } from "cloudflare:workers";
import { KernelProgramRegistry } from "../../../src/kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../../src/kernel/KernelProgramHost.ts";
import { createComputerCommands } from "../../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../../src/computer/EscalationTable.ts";
import { ChildWorkerCapacity } from "../../../src/computer/ChildWorkerCapacity.ts";
import { createChildWorkerProgram } from "../../../src/computer/ChildWorkerProgram.ts";
import { createKernelSyscallHost } from "../../../src/kernel/KernelSyscallHost.ts";
import { createKernelTscFileSystem } from "../../../src/kernel/KernelTscFileSystemHost.ts";
import childModules from "./child-modules.js";
import { KernelWakeRegistry } from "../../../src/kernel/KernelWakeRegistry.ts";
import { KERNEL_TSC_ARTIFACT, KERNEL_TSC_PROGRAM_MANIFEST } from "../../../src/kernel/KernelTscProgram.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const good = 'import type {Item} from "./model";\nexport const item: Item = { name: "probe", count: 1 };\n';
const bad = 'import type {Item} from "./model";\nexport const item: Item = { name: "probe", count: "wrong" };\n';

class TscHost extends RpcTarget {
  constructor(syscalls,filesystem,observations,counters) {super();this.syscalls=syscalls;this.filesystem=filesystem;this.observations=observations;this.counters=counters;}
  call(request) {this.counters.syscalls++;return this.syscalls.call(request);}
  execute(request) {this.counters.filesystem++;return this.filesystem.execute(request);}
  observe(value) {this.observations.push(value);}
}

export class ProbeFacet extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/proof" && path !== "/proof-again" && path !== "/large-policy") return new Response("Not found", {status:404});
    const filesystem = new KernelFileSystem({mounts:[{
      path:"/",storage:createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1000000n),
    }]});
    const wakes = new KernelWakeRegistry();
    const registry = new KernelProgramRegistry();
    let forwardingCalls = 0;
    const observations = [];
    const counters = {syscalls:0,filesystem:0};
    // Each CHILD_WORKERS RPC gets one plain Worker request and one child fetch; this DO gates ten RPCs (2026-10-23 probe, see computer/README.md).
    const capacity = new ChildWorkerCapacity(10, {
      owner: "thread/" + this.ctx.id.toString(),
      storage: this.ctx.storage,
    });
    let dispatches = 0;
    let closedHosts = 0;
    try {
      directory(filesystem,"/work");
      write(filesystem,"/work/tsconfig.json",JSON.stringify({compilerOptions:{strict:true,noEmit:true,types:[]},files:["model.ts","index.ts"]}));
      write(filesystem,"/work/model.ts","export interface Item { name: string; count: number };\n");
      if (path === "/large-policy") return Response.json(await policyProbe(filesystem));
      const registration = registry.register(KERNEL_TSC_PROGRAM_MANIFEST);
      assert(registration.status === "ok","registration failed");
      const host = new KernelProgramHost({registry,wakes,programs:new Map([["/bin/tsc-rs",{
        manifest:KERNEL_TSC_PROGRAM_MANIFEST,implementation:createChildWorkerProgram({
          executable:"/bin/tsc-rs",capacity,
          code:{mainModule:"main.js",modules:{...childModules,"ts_rust.wasm":{wasm:await request.arrayBuffer()}}},
          dispatch:{run:(input,host) => {dispatches++;return this.env.CHILD_WORKERS.run(input,host);}},
          createHost:context => {
            const owner=createKernelSyscallHost({filesystem:context.filesystem,args:context.args,env:context.env,signal:context.signal});
            return {host:new TscHost(owner,createKernelTscFileSystem(context.filesystem),observations,counters),close:() => {owner.close();closedHosts++;}};
          },
        }),
      }]])});
      const executor = createComputerCommands({kernel:{host,filesystem},escalation:new ComputerEscalationTable(),machine:{spawn(){forwardingCalls++;throw new Error("unexpected machine forwarding");}}});
      const results = [];
      for (const item of [
        {name:"good",source:good,exit:0},
        {name:"diagnostic",source:bad,exit:2,diagnostic:"TS2322"},
        {name:"fixed",source:good,exit:0},
      ]) {
        write(filesystem,"/work/index.ts",item.source);
        const args = ["alternate-argv0","-p",".","--pretty","false"];
        const env = {PWD:"/stale",NO_COLOR:"1",EXACT:"keep"};
        const result = await run(executor,{executable:"/bin/tsc-rs",argv:args,cwd:"/work",env});
        assert(result.exit.exitCode === item.exit,item.name+" exit: "+JSON.stringify(result));
        assert(result.exit.signal === 0 && !result.exit.coreDumped,item.name+" signal");
        assert(result.stderr === "",item.name+" stderr: "+result.stderr);
        if (item.diagnostic) assert(result.stdout.includes(item.diagnostic),"missing actual diagnostic");
        else assert(result.stdout === "",item.name+" unexpected stdout");
        assert(host.processes.size === 0 && wakes.size === 0,"retained process or wake");
        results.push({name:item.name,...result,args,cwd:"/work",env});
      }
      const emit = await run(executor,{executable:"/bin/tsc-rs",argv:["tsc-rs","-p",".","--noEmit","false","--outDir","out","--pretty","false"],cwd:"/work",env:{NO_COLOR:"1"}});
      assert(emit.exit.exitCode === 0 && emit.stderr === "","emit failed: "+JSON.stringify(emit));
      const emitted = read(filesystem,"/work/out/index.js");
      assert(emitted.includes('export const item = { name: "probe", count: 1 };'),"emitted bytes mismatch: "+emitted);
      assert(host.processes.size === 0 && wakes.size === 0,"retained process after emit");
      assert(forwardingCalls === 0,"command forwarded");
      assert(dispatches === 4 && observations.length === 4 && closedHosts === 4,"child invocation or cleanup mismatch");
      assert(capacity.active === 0,"child capacity retained");
      assert(counters.syscalls > 0 && counters.filesystem > 0,"child did not use parent RPC");
      assert(observations.every(value => value.command.cwd === "/work" && value.command.env.NO_COLOR === "1"),"child command values changed");
      assert(read(filesystem,"/work/index.ts") === good,"compiler changed source");
      return Response.json({ok:true,path,artifact:KERNEL_TSC_ARTIFACT,results,emit,emitted,forwardingCalls,dispatches,closedHosts,observations,counters,capacity:capacity.active,processes:host.processes.size,wakes:wakes.size});
    } catch(error) {
      return Response.json({ok:false,path,error:String(error),stack:error?.stack},{status:500});
    } finally {
      filesystem.dispose();
      wakes.dispose();
    }
  }
}

async function run(executor,command) {
  const child = await executor.exec(command,new AbortController().signal,undefined);
  const stdout = stream(child.stdout);
  const stderr = stream(child.stderr);
  const writer = child.stdin.getWriter();
  try { await writer.close(); } finally { writer.releaseLock(); }
  try {
    const [exit,out,err] = await Promise.all([child.exited,stdout,stderr]);
    return {exit,stdout:out,stderr:err};
  } finally { await child.dispose(); }
}
async function stream(value) {
  const reader=value.getReader();
  const text=new TextDecoder();
  let output="";
  try {
    for (;;) {
      const next=await reader.read();
      if(next.done)return output+text.decode();
      output+=text.decode(next.value,{stream:true});
    }
  } finally {reader.releaseLock();}
}
function directory(filesystem,path) {
  try {filesystem.mkdir(path);} catch(error) {if(error?.code!=="EEXIST")throw error;}
}
function write(filesystem,path,text) {
  const fd=filesystem.open(path,KernelOpenFlags.O_WRONLY|KernelOpenFlags.O_CREAT|KernelOpenFlags.O_TRUNC);
  try {filesystem.write(fd,encoder.encode(text),null);} finally {filesystem.close(fd);}
}
function read(filesystem,path) {
  const fd=filesystem.open(path,KernelOpenFlags.O_RDONLY);
  const bytes=[];
  try {
    for (;;) {
      const chunk=new Uint8Array(1024);
      const count=filesystem.read(fd,chunk,null);
      if(count===0)return bytes.map(value=>decoder.decode(value)).join("");
      bytes.push(chunk.slice(0,count));
    }
  } finally {filesystem.close(fd);}
}
async function policyProbe(filesystem) {
  directory(filesystem,"/work/large");
  const files = Array.from({length:64},(_,index) => "part"+index+".ts");
  const source = Array.from({length:256},(_,index) => "export const value"+index+": number = "+index+";\n").join("");
  for (const file of files) write(filesystem,"/work/large/"+file,source);
  write(filesystem,"/work/large/tsconfig.json",JSON.stringify({compilerOptions:{strict:true,noEmit:true,types:[]},files}));
  const workspaceBytes = Number(filesystem.stat("/work/large/tsconfig.json").size) + files.reduce((sum,file) => sum+Number(filesystem.stat("/work/large/"+file).size),0);
  const command = {executable:"/bin/tsc-rs",argv:["tsc-rs","-p",".","--noEmit"],cwd:"/work/large",env:{NO_COLOR:"1",EXACT:"large-policy"}};
  const rule = {id:"measured-fixture-only",executable:"/bin/tsc-rs",argvPrefix:["-p","."],minimumWorkspaceBytes:workspaceBytes};
  const escalation = new ComputerEscalationTable([rule]);
  assert(escalation.decide(command,{workspaceBytes:workspaceBytes-1}).kind === "isolate","below configured threshold escalated");
  let dispatched;
  let localCalls=0;
  const sentinel = new Error("policy probe reached machine port");
  const commands = createComputerCommands({kernel:{filesystem,host:{spawn(){localCalls++;throw new Error("policy probe reached child host");}}},escalation,evidence:async () => ({workspaceBytes}),machine:{spawn(value){dispatched=value;throw sentinel;}}});
  let caught;
  try {await commands.exec(command,new AbortController().signal,undefined);} catch(error) {caught=error;}
  assert(caught === sentinel && localCalls === 0,"machine dispatch failed or retried locally");
  assert(JSON.stringify(dispatched) === JSON.stringify(command),"machine command changed");
  return {ok:true,proof:"configured machine-port selection only",files:files.length,workspaceBytes,rule,command:dispatched,localCalls,machineCalls:1};
}
function assert(value,message) {if(!value)throw new Error(message);}
`;
