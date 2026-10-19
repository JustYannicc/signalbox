// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - drive the actual host entrypoint and caller adapter in workerd.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: URL;
let evidence: string;

const child = `import {WorkerEntrypoint} from "cloudflare:workers";
const started=Promise.withResolvers(),cleanupStarted=Promise.withResolvers(),release=Promise.withResolvers();
const state={abortSeen:false,fetchFinished:false,cancelStarted:false,cancelFinished:false,envEmpty:false,outboundBlocked:false,receiver:false};
// The native timer keeps the request alive and can only fail the test. Success requires explicit release.
function gate(promise){return new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>reject(new Error("Native test gate deadline exceeded")),10000);
  promise.then(value=>{clearTimeout(deadline);resolve(value)},error=>{clearTimeout(deadline);reject(error)});
});}
async function invoke(request,env,receiver){
  const {mode,operation}=await request.json();
  if(operation==="wait-start"){await gate(started.promise);return Response.json(state);}
  if(operation==="wait-cleanup"){await gate(cleanupStarted.promise);return Response.json(state);}
  if(operation==="release"){release.resolve();return Response.json(state);}
  if(operation==="status")return Response.json(state);
  state.envEmpty=Object.keys(env).length===0;state.receiver=receiver;
  try{await fetch("https://example.com/");}catch{state.outboundBlocked=true;}
  if(mode==="before"){
    const aborted=new Promise(resolve=>request.signal.addEventListener("abort",resolve,{once:true}));
    started.resolve();
    try{await gate(aborted);state.abortSeen=request.signal.aborted;request.signal.throwIfAborted();return new Response("late");}
    finally{cleanupStarted.resolve();await gate(release.promise);state.fetchFinished=true;}
  }
  state.fetchFinished=true;started.resolve();
  return new Response(new ReadableStream({
    start(controller){controller.enqueue(new Uint8Array([0,255,128,42]));},
    async cancel(){state.cancelStarted=true;cleanupStarted.resolve();await gate(release.promise);state.cancelFinished=true;},
  }),{status:418,statusText:"Native teapot",headers:{"x-fixture":"kept"}});
}
const objectHandler={value:42,fetch(request,env){return invoke(request,env,this.value===42)}};
class ClassHandler extends WorkerEntrypoint {value=42;fetch(request){return invoke(request,this.env,this.value===42)}}
export default __DEFAULT__;`;

const host = `
import {codeGenerationBinding} from "./infra/isolateProbe/codeGeneration.ts";
export {CodeGeneration} from "./infra/isolateProbe/codeGeneration.ts";
import {createNodeGeneratedCodeFetcher,NodeGeneratedCodeCleanupError} from "./src/isolate/NodeGeneratedCode.ts";
function invoke(fetcher,modules,input,signal,id="proof"){
  return fetcher.fetch(new Request("https://code-generation.invalid/invoke",{
    method:"POST",headers:{"content-type":"application/json"},signal,
    body:JSON.stringify({id,mainModule:"user.js",modules,input}),
  }));
}
async function cancellation(kind,mode){
  const namespace=kind+"/"+mode;
  const modules={"user.js":${JSON.stringify(child)}.replace("__DEFAULT__",kind==="class"?"ClassHandler":"objectHandler")};
  const fetcher=createNodeGeneratedCodeFetcher(codeGenerationBinding(namespace));
  const control=async operation=>await(await invoke(fetcher,modules,{operation})).json();
  const abort=new AbortController();const reason=new Error("owner cancelled");
  let fetchSettled=false,readSettled=false,cancelSettled=false;
  const outcome=invoke(fetcher,modules,{mode},abort.signal).then(
    response=>{fetchSettled=true;return {response}},
    error=>{fetchSettled=true;return {error:String(error),sameReason:error===reason,code:error.code}},
  );
  let metadata,first,reader,reading,cancelling;
  if(mode==="before")await control("wait-start");
  else{
    const response=(await outcome).response;
    if(!response)throw new Error(JSON.stringify(await outcome));
    metadata={status:response.status,statusText:response.statusText,headers:[...response.headers]};
    reader=response.body.getReader();first=Array.from((await reader.read()).value);
    reading=reader.read().then(value=>{readSettled=true;return {value}},error=>{readSettled=true;return {sameReason:error===reason}});
  }
  abort.abort(reason);
  const during=await control("wait-cleanup");
  const fetchSettledBeforeRelease=fetchSettled,readSettledBeforeRelease=readSettled;
  if(reader)cancelling=reader.cancel(reason).then(()=>{cancelSettled=true;return {ok:true}});
  const cancelSettledBeforeRelease=cancelSettled;
  await control("release");
  const final=mode==="before"?await outcome:{reading:await reading,cancellation:await cancelling};
  const after=await control("status");reader?.releaseLock();
  return {kind,mode,metadata,first,during,fetchSettledBeforeRelease,readSettledBeforeRelease,cancelSettledBeforeRelease,final,after};
}
export default {async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==="/cancellation"){
    const cases=[];
    for(const kind of ["object","class"])for(const mode of ["before","stream"])cases.push(await cancellation(kind,mode));
    return Response.json(cases);
  }
  if(path==="/lifetime"){
    const binding=codeGenerationBinding("lifetime");
    const results=[];
    for(const source of [
      'throw new Error("user top level executed");export default {};',
      'import {WorkerEntrypoint} from "cloudflare:workers";export default class extends WorkerEntrypoint {constructor(...args){super(...args);throw new Error("user constructor executed")}}',
    ]){
      const handle=await binding.open(JSON.stringify({id:"proof",mainModule:"user.js",modules:{"user.js":source},input:null}));
      const error=await handle.run().catch(error=>String(error));
      await handle.cancel();handle[Symbol.dispose]();results.push({opened:true,error,cleanupAcknowledged:true});
    }
    return Response.json(results);
  }
  if(path==="/bytes"){
    const modules={"user.js":'let body;export default {async fetch(request){if((await request.json()).status)return Response.json({locked:body.locked});body=new ReadableStream({start(controller){const bytes=new Uint8Array(131075);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;controller.enqueue(bytes);controller.close()}});return new Response(body,{status:203,statusText:"Native bytes",headers:{"x-native":"yes","set-cookie":"one=1"}})}}',
      "__signalbox_generated_invocation.js":'throw new Error("colliding module must stay unevaluated");'};
    const fetcher=createNodeGeneratedCodeFetcher(codeGenerationBinding("bytes"));
    const response=await invoke(fetcher,modules,{});
    const reader=response.body.getReader();const chunks=[];let bytesValid=true,offset=0;
    for(;;){const next=await reader.read();if(next.done)break;chunks.push(next.value.length);for(const byte of next.value){if(byte!==offset%256)bytesValid=false;offset++;}}
    reader.releaseLock();
    const status=await(await invoke(fetcher,modules,{status:true})).json();
    return Response.json({status:response.status,statusText:response.statusText,headers:[...response.headers],chunks,bytesValid,length:offset,bodyLocked:status.locked});
  }
  if(path==="/cleanup-failure"){
    const modules={"user.js":'let body;export default {async fetch(request){if((await request.json()).status)return Response.json({locked:body.locked});body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([42]))},cancel(){throw new Error("native cleanup rejected")}});return new Response(body)}}'};
    const fetcher=createNodeGeneratedCodeFetcher(codeGenerationBinding("cleanup-failure"));
    const response=await invoke(fetcher,modules,{});const reader=response.body.getReader();await reader.read();
    const error=await reader.cancel().catch(error=>error);reader.releaseLock();
    const status=await(await invoke(fetcher,modules,{status:true})).json();
    return Response.json({typed:error instanceof NodeGeneratedCodeCleanupError,code:error.code,cause:String(error.cause),bodyLocked:status.locked});
  }
  if(path==="/cache"){
    const main='import {value} from "./value.js";let count=0;export default {fetch(){return Response.json({count:++count,value})}}';
    const fetcher=createNodeGeneratedCodeFetcher(codeGenerationBinding("cache"));
    const first={"user.js":main,"value.js":"export const value=1"};
    const reordered={"value.js":first["value.js"],"user.js":main};
    const changed={...first,"value.js":"export const value=2"};
    return Response.json([
      await(await invoke(fetcher,first,1,undefined,"one")).json(),
      await(await invoke(fetcher,reordered,2,undefined,"two")).json(),
      await(await invoke(fetcher,changed,3)).json(),
      await(await invoke(createNodeGeneratedCodeFetcher(codeGenerationBinding("other-cache")),first,4)).json(),
    ]);
  }
  return new Response("missing",{status:404});
}};`;

beforeAll(async () => {
  const base = "/tmp/issue-1066/generated-cancel-work/intrinsics-fix-r4/";
  await NodeFSP.mkdir(base, { recursive: true });
  evidence = await NodeFSP.mkdtemp(NodePath.join(base, "lifecycle-source-"));
  await NodeFSP.writeFile(NodePath.join(evidence, "host-source.ts"), host);
  await build({
    stdin: {
      contents: host,
      resolveDir: NodePath.resolve(import.meta.dirname, "../.."),
      sourcefile: "managed-native-host.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    external: ["cloudflare:workers", "node:*"],
    outfile: NodePath.join(evidence, "host.js"),
  });
  const configPath = NodePath.join(evidence, "wrangler.jsonc");
  await NodeFSP.writeFile(
    configPath,
    JSON.stringify({
      name: "generated-managed-native",
      main: "host.js",
      no_bundle: true,
      compatibility_date: "2026-10-18",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
    }),
  );
  harness = createTestHarness({ workers: [{ configPath }] });
  endpoint = (await harness.listen()).url;
});

afterAll(async () => {
  if (harness) {
    await NodeFSP.writeFile(
      NodePath.join(evidence, "logs.json"),
      JSON.stringify(await harness.getLogs(), null, 2),
    );
    await harness.close();
  }
});

async function run(path: string) {
  const response = await fetch(new URL(path, endpoint), { signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  await NodeFSP.writeFile(
    NodePath.join(evidence, `${path.slice(1)}.json`),
    JSON.stringify({ status: response.status, body }, null, 2),
  );
  expect(response.status).toBe(200);
  return JSON.parse(body);
}

describe("actual managed generated-code RPC", () => {
  it("waits for native fetch and stream cleanup for object and class handlers", async () => {
    const results = await run("/cancellation");
    for (const kind of ["object", "class"]) {
      expect(results).toContainEqual(
        expect.objectContaining({
          kind,
          mode: "before",
          fetchSettledBeforeRelease: false,
          during: expect.objectContaining({
            abortSeen: true,
            fetchFinished: false,
            envEmpty: true,
            outboundBlocked: true,
            receiver: true,
          }),
          after: expect.objectContaining({ fetchFinished: true }),
          final: expect.objectContaining({ sameReason: true }),
        }),
      );
      expect(results).toContainEqual(
        expect.objectContaining({
          kind,
          mode: "stream",
          readSettledBeforeRelease: false,
          cancelSettledBeforeRelease: false,
          first: [0, 255, 128, 42],
          metadata: { status: 418, statusText: "Native teapot", headers: [["x-fixture", "kept"]] },
          during: expect.objectContaining({
            cancelStarted: true,
            cancelFinished: false,
            envEmpty: true,
            outboundBlocked: true,
            receiver: true,
          }),
          after: expect.objectContaining({ cancelFinished: true }),
          final: expect.objectContaining({ cancellation: { ok: true } }),
        }),
      );
    }
  });

  it("does not evaluate user modules or construct handlers during open", async () => {
    expect(await run("/lifetime")).toEqual([
      { opened: true, error: "Error: user top level executed", cleanupAcknowledged: true },
      { opened: true, error: "Error: user constructor executed", cleanupAcknowledged: true },
    ]);
  });

  it("bounds RPC chunks, preserves bytes and metadata, and unlocks the child reader at EOF", async () => {
    expect(await run("/bytes")).toEqual({
      status: 203,
      statusText: "Native bytes",
      headers: [
        ["set-cookie", "one=1"],
        ["x-native", "yes"],
      ],
      chunks: [65536, 65536, 3],
      bytesValid: true,
      length: 131075,
      bodyLocked: false,
    });
  });

  it("keeps failed native body cleanup unconfirmed", async () => {
    expect(await run("/cleanup-failure")).toEqual({
      typed: true,
      code: "CLEANUP_UNCONFIRMED",
      cause: "Error: native cleanup rejected",
      bodyLocked: true,
    });
  });

  it("keeps canonical source identity immutable and namespaces separate", async () => {
    expect(await run("/cache")).toEqual([
      { count: 1, value: 1 },
      { count: 2, value: 1 },
      { count: 1, value: 2 },
      { count: 1, value: 1 },
    ]);
  });
});
