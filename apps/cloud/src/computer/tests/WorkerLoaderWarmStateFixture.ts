// @effect-diagnostics nodeBuiltinImport:off - this fixture supplies generated code and a tiny WASI image to native workerd tests.

export interface WarmStateResult {
  readonly kind: "direct" | "registry";
  readonly observations: readonly {
    readonly isolate: string;
    readonly calls: number;
    readonly previous: string | null;
    readonly memoryBefore: number;
    readonly stdinStat: number;
    readonly stdinClose: number;
    readonly args: readonly string[];
    readonly env: readonly string[];
  }[];
  readonly stdout: readonly string[];
  readonly active: number;
}

const child = `import {WorkerEntrypoint} from "cloudflare:workers";
import module from "./counter.wasm";
import {createChildWasi} from "./ChildWasi.js";
let isolate;let calls=0;
export class Child extends WorkerEntrypoint {
  async run(command,owner){
    isolate??=crypto.randomUUID();
    const previous=this.previous??null;this.previous=command.argv[0];
    const wasi=createChildWasi({module,syscalls:owner,args:command.argv,env:command.env});
    const instance=new WebAssembly.Instance(module,wasi.imports);wasi.bind(instance);
    const memory=instance.exports.memory;
    const memoryBefore=new Uint8Array(memory.buffer)[0];
    const exitCode=await wasi.start(instance);
    const vector=(table,count)=>{const view=new DataView(memory.buffer),bytes=new Uint8Array(memory.buffer),decoder=new TextDecoder();return Array.from({length:count},(_,i)=>{const start=view.getUint32(table+i*4,true);let end=start;while(bytes[end]!==0)end++;return decoder.decode(bytes.subarray(start,end));});};
    await owner.observed({isolate,calls:++calls,previous,memoryBefore,stdinStat:new DataView(memory.buffer).getUint32(20,true),stdinClose:new DataView(memory.buffer).getUint32(24,true),args:vector(32,command.argv.length),env:vector(128,Object.keys(command.env).length)});
    return {exitCode,signal:0,coreDumped:false};
  }
}`;

export function warmStateHost(childWasiSource: string, wasmHash: string) {
  return `import {RpcTarget} from "cloudflare:workers";
import module from "./counter.wasm";
import {createWorkerLoaderDispatch} from "./src/computer/WorkerLoaderDispatch.ts";
import {createCompiledChildWorkerLoader} from "./src/computer/CompiledChildWorkerLoader.ts";
import {createChildWorkerProgram} from "./src/computer/ChildWorkerProgram.ts";
import {ChildWorkerCapacity} from "./src/computer/ChildWorkerCapacity.ts";
import {KernelFileSystem} from "./src/kernel/KernelFileSystem.ts";
import {KernelProcessTable} from "./src/kernel/KernelProcessTable.ts";
import {KernelWakeRegistry} from "./src/kernel/KernelWakeRegistry.ts";
import {createKernelSyscallHost} from "./src/kernel/KernelSyscallHost.ts";
const modules={"main.js":${JSON.stringify(child)},"ChildWasi.js":${JSON.stringify(childWasiSource)}};
class Owner extends RpcTarget {
  constructor(syscalls,observations){super();this.syscalls=syscalls;this.observations=observations;}
  call(request){return this.syscalls.call(request);}
  observed(value){this.observations.push(value);}
}
export default {async fetch(request,env){
  const kind=new URL(request.url).searchParams.get("kind");
  const freshIsolate=new URL(request.url).searchParams.has("fresh");
  if(kind!=="direct"&&kind!=="registry")return new Response("missing",{status:404});
  const capacity=new ChildWorkerCapacity(),observations=[],stdout=[];
  for(const [marker,secret]of [["first","one"],["second","two"]]){
    const output=[];
    const filesystem=new KernelFileSystem({mounts:[],stdio:[{readInto:()=>0},{write:bytes=>{output.push(...bytes);return bytes.length;}},{}]});
    const args=[marker,"雪"],variables={PRIVATE:secret,PWD:"/"},signal=new AbortController().signal;
    const wakes=new KernelWakeRegistry(),processes=new KernelProcessTable({wakes});
    const completion=Promise.withResolvers();
    const process=processes.spawn(undefined,()=>({completion:completion.promise,signal:()=>({status:"ok",value:undefined})}),()=>{});
    if(process.status!=="ok")throw new Error("Warm process admission failed");
    const syscalls=createKernelSyscallHost({filesystem,args,env:variables,signal});
    const loader=kind==="direct"?env.LOADER:createCompiledChildWorkerLoader(env.LOADER,new Map([[${JSON.stringify(wasmHash)},module]]));
    const dispatch=createWorkerLoaderDispatch(loader);
    const program=createChildWorkerProgram({executable:"/bin/warm-proof",capacity,dispatch,
      code:{mainModule:"main.js",entrypoint:"Child",freshIsolate,modules:{...modules,"counter.wasm":kind==="direct"?{wasm:module}:{wasmReference:${JSON.stringify(wasmHash)}}}},
      createHost:()=>({host:new Owner(syscalls,observations),close:()=>syscalls.close()}),
    });
    try{
      const exit=await program.run({args,env:variables,filesystem,signal,identity:process.value,processes,wakes,home:undefined});
      await program.drain();
      if(exit.exitCode!==0)throw new Error("Warm child failed "+JSON.stringify(exit));
      stdout.push(new TextDecoder().decode(new Uint8Array(output)));
    }finally{completion.resolve({exitCode:0,signal:0,coreDumped:false});await processes.dispose();wakes.dispose();filesystem.dispose();}
  }
  return Response.json({kind,observations,stdout,active:capacity.active});
}};`;
}

/** A mutable WASM global starts at zero, writes its increment and closes the invocation's stdin. */
export function warmStateWasm() {
  const name = (value: string) => {
    const bytes = [...new TextEncoder().encode(value)];
    return [bytes.length, ...bytes];
  };
  const leb = (value: number): number[] => {
    const result: number[] = [];
    do {
      const byte = value & 127;
      value >>>= 7;
      result.push(byte | (value ? 128 : 0));
    } while (value);
    return result;
  };
  const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
  const i32 = (value: number) => [0x41, ...leb(value)];
  const call = (index: number, args: number[]) => [...args, 0x10, index, 0x1a];
  const store = (pointer: number, value: number) => [...i32(pointer), ...i32(value), 0x36, 2, 0];
  const body = [
    0,
    ...call(0, [...i32(32), ...i32(256)]),
    ...call(1, [...i32(128), ...i32(512)]),
    ...i32(20),
    ...i32(0),
    ...i32(768),
    0x10,
    2,
    0x36,
    2,
    0,
    ...i32(24),
    ...i32(0),
    0x10,
    3,
    0x36,
    2,
    0,
    // Increment the WASM global, then write its ASCII digit through stdout.
    0x23,
    0,
    ...i32(1),
    0x6a,
    0x24,
    0,
    ...i32(0),
    0x23,
    0,
    ...i32(48),
    0x6a,
    0x3a,
    0,
    0,
    ...store(8, 0),
    ...store(12, 1),
    ...call(4, [...i32(1), ...i32(8), ...i32(1), ...i32(16)]),
    0x0b,
  ];
  const wasiImport = (value: string, type: number) => [
    ...name("wasi_snapshot_preview1"),
    ...name(value),
    0,
    type,
  ];
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(
      1,
      [
        4, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1,
        0x7f, 0x60, 0, 0,
      ],
    ),
    ...section(2, [
      5,
      ...wasiImport("args_get", 0),
      ...wasiImport("environ_get", 0),
      ...wasiImport("fd_fdstat_get", 0),
      ...wasiImport("fd_close", 1),
      ...wasiImport("fd_write", 2),
    ]),
    ...section(3, [1, 3]),
    ...section(5, [1, 0, 1]),
    ...section(6, [1, 0x7f, 1, ...i32(0), 0x0b]),
    ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 5]),
    ...section(10, [1, ...leb(body.length), ...body]),
  ]);
}
