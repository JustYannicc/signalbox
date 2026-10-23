// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - generated code deliberately tampers with its realm in real workerd.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: URL;
let evidence: string;

const child = `
const attack="__ATTACK__";
const apply=Reflect.apply,getReader=ReadableStream.prototype.getReader;
const attempt=Promise.withResolvers(),cancelAttempt=Promise.withResolvers(),release=Promise.withResolvers();
let body;
const state={spoofCalls:0,readStarted:false,eof:false,cancelStarted:false,cancelFinished:false,signalAborted:false};
function gate(promise){return new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>reject(new Error("Intrinsic proof gate deadline exceeded")),10000);
  promise.then(value=>{clearTimeout(deadline);resolve(value)},error=>{clearTimeout(deadline);reject(error)});
});}
function spoof(){state.spoofCalls++;attempt.resolve();}
const fakeRead=async()=>{spoof();return {done:true};};
const fakeCancel=async()=>{spoof();cancelAttempt.resolve();};
if(attack==="prototype-eof"){
  ReadableStreamDefaultReader.prototype.read=fakeRead;
  ReadableStreamDefaultReader.prototype.releaseLock=()=>{};
}
if(attack==="prototype-cancel"){
  ReadableStreamDefaultReader.prototype.cancel=fakeCancel;
  ReadableStreamDefaultReader.prototype.releaseLock=()=>{};
  Reflect.apply=()=>{throw new Error("Guest Reflect.apply must not run");};
}
if(attack==="abort-prototype")AbortController.prototype.abort=()=>{};
export default {async fetch(request){
  const {operation}=await request.json();
  if(operation){
    if(operation==="attempt")await gate(attempt.promise);
    if(operation==="cancel-attempt")await gate(cancelAttempt.promise);
    if(operation==="release")release.resolve();
    return new Response(null,{status:204,headers:{"x-state":JSON.stringify({...state,locked:body?.locked??false})}});
  }
  let sent=false;
  body=new ReadableStream({
    async pull(controller){
      if(!sent){sent=true;state.readStarted=true;controller.enqueue(new Uint8Array([0,255,128,42]));attempt.resolve();return;}
      await gate(release.promise);
      if(!state.cancelStarted){controller.close();state.eof=true;}
    },
    async cancel(){
      state.signalAborted=request.signal.aborted;state.cancelStarted=true;cancelAttempt.resolve();
      await gate(release.promise);state.cancelFinished=true;
    },
  },{highWaterMark:0});
  if(attack==="own-getReader-eof")body.getReader=()=>({read:fakeRead,cancel:fakeCancel,releaseLock(){}});
  if(attack==="own-cancel")body.getReader=()=>{
    const reader=apply(getReader,body,[]);reader.cancel=fakeCancel;reader.releaseLock=()=>{};return reader;
  };
  const response=new Response(body);
  if(attack==="own-body-eof")Object.defineProperty(response,"body",{get(){spoof();return null;}});
  return response;
}};`;

const host = `
import {codeGenerationBinding} from "./infra/isolateProbe/codeGeneration.ts";
export {CodeGeneration} from "./infra/isolateProbe/codeGeneration.ts";
import {createNodeGeneratedCodeFetcher,NodeGeneratedCodeCleanupError} from "./src/isolate/NodeGeneratedCode.ts";
import {createHookService} from "./src/hooks/HookService.ts";
import {ChildWorkerCapacity} from "./src/computer/ChildWorkerCapacity.ts";
export default {async fetch(request){
  const attack=new URL(request.url).pathname.slice(1);
  const program={id:"intrinsics",mainModule:"user.js",modules:{"user.js":${JSON.stringify(child)}.replace("__ATTACK__",attack)}};
  const fetcher=createNodeGeneratedCodeFetcher(codeGenerationBinding("intrinsics/"+attack));
  const invoke=(input,signal)=>fetcher.fetch(new Request("https://code-generation.invalid/invoke",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input),signal,
  }));
  const control=async operation=>JSON.parse((await invoke({...program,input:{operation}})).headers.get("x-state"));
  // Plain Worker ceiling from the 2026-10-23 probe; see apps/cloud/src/computer/README.md.
  const capacity=new ChildWorkerCapacity(4,{owner:"test/managed-invocation-intrinsics"});
  const service=createHookService({capacity,commands:{exec(){throw new Error("wrong path")}},
    registrations:new Map([["script",{kind:"script",harness:"claude-code",event:"pre-tool-use",sessionId:"intrinsics",program}]]),
    generated:{invoke(input,options){return invoke(input,options?.signal)}},
  });
  const abort=new AbortController();const reason=new Error("cancel intrinsic proof");let settled=false;
  const outcome=service.invoke("script",{},{cwd:"/work",env:{},signal:abort.signal}).then(
    result=>{settled=true;return {stdout:[...result.stdout]}},
    error=>{settled=true;return {sameReason:error===reason,cleanupUnknown:error instanceof NodeGeneratedCodeCleanupError,error:String(error)}},
  );
  const eof=attack.endsWith("-eof");
  const started=await control("attempt");
  if(!eof)abort.abort(reason);
  const during=eof?started:await control("cancel-attempt");
  // The vulnerable path has already forged completion. Observe that outcome directly, without a timeout race.
  if(during.spoofCalls)await outcome;
  const activeBeforeRelease=capacity.active,settledBeforeRelease=settled;
  await control("release");
  const result=await outcome;
  const after=await control("status");
  return Response.json({attack,started,during,activeBeforeRelease,settledBeforeRelease,result,after,activeAfterRelease:capacity.active});
}};`;

beforeAll(async () => {
  const base = "/tmp/issue-1066/generated-cancel-work/intrinsics-fix-r4/";
  await NodeFSP.mkdir(base, { recursive: true });
  evidence = await NodeFSP.mkdtemp(NodePath.join(base, "native-source-"));
  await NodeFSP.writeFile(NodePath.join(evidence, "host-source.ts"), host);
  await build({
    stdin: {
      contents: host,
      resolveDir: NodePath.resolve(import.meta.dirname, "../.."),
      sourcefile: "intrinsics-native-host.ts",
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
      name: "generated-intrinsics-native",
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

async function run(attack: string) {
  const response = await fetch(new URL(`/${attack}`, endpoint), {
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  await NodeFSP.writeFile(
    NodePath.join(evidence, `${attack}.json`),
    JSON.stringify({ status: response.status, body }, null, 2),
  );
  expect(response.status).toBe(200);
  return JSON.parse(body);
}

describe("native generated body intrinsics", () => {
  it.each(["own-body-eof", "own-getReader-eof", "prototype-eof"])(
    "ignores %s and holds admission until actual EOF",
    async (attack) => {
      expect(await run(attack)).toMatchObject({
        attack,
        activeBeforeRelease: 1,
        settledBeforeRelease: false,
        during: { spoofCalls: 0, readStarted: true, eof: false, locked: true },
        result: { stdout: [0, 255, 128, 42] },
        after: { spoofCalls: 0, eof: true, locked: false },
        activeAfterRelease: 0,
      });
    },
  );
  it.each(["own-cancel", "prototype-cancel", "abort-prototype"])(
    "ignores %s and holds admission until actual cancellation",
    async (attack) => {
      expect(await run(attack)).toMatchObject({
        attack,
        activeBeforeRelease: 1,
        settledBeforeRelease: false,
        during: {
          spoofCalls: 0,
          cancelStarted: true,
          cancelFinished: false,
          signalAborted: true,
          locked: true,
        },
        result: { sameReason: true, cleanupUnknown: false },
        after: { spoofCalls: 0, cancelFinished: true, locked: false },
        activeAfterRelease: 0,
      });
    },
  );
});
