// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - prove real hook admission against native generated-worker cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness> | undefined;
let endpoint: URL;
let evidence: string;

const child = `
const readStarted=Promise.withResolvers(),cleanupStarted=Promise.withResolvers(),release=Promise.withResolvers();
let body;
const state={runs:0,readStarted:false,cancelStarted:false,cancelFinished:false,cancelRejected:false};
function snapshot(){return {...state,bodyLocked:body?.locked??false};}
// This native timer only fails a stuck test. Explicit child milestones and release establish success.
function gate(promise){return new Promise((resolve,reject)=>{
  const deadline=setTimeout(()=>reject(new Error("Native capacity gate deadline exceeded")),10000);
  promise.then(value=>{clearTimeout(deadline);resolve(value)},error=>{clearTimeout(deadline);reject(error)});
});}
export default {async fetch(request){
  const {mode,operation}=await request.json();
  if(operation==="wait-read"){await gate(readStarted.promise);return Response.json(snapshot());}
  if(operation==="wait-cleanup"){await gate(cleanupStarted.promise);return Response.json(snapshot());}
  if(operation==="release"){release.resolve();return Response.json(snapshot());}
  if(operation==="status")return Response.json(snapshot());
  state.runs++;
  body=new ReadableStream({
    pull(controller){
      if(!state.readStarted){
        controller.enqueue(new Uint8Array([0,255,128,42]));state.readStarted=true;readStarted.resolve();
      }
    },
    async cancel(){
      state.cancelStarted=true;cleanupStarted.resolve();await gate(release.promise);
      if(mode==="failed"){state.cancelRejected=true;throw new Error("actual child cleanup rejected");}
      state.cancelFinished=true;
    },
  },{highWaterMark:0});
  return new Response(body);
}};`;

const host = `
import {codeGenerationBinding} from "./infra/isolateProbe/codeGeneration.ts";
export {CodeGeneration} from "./infra/isolateProbe/codeGeneration.ts";
import {createNodeGeneratedCodeFetcher,NodeGeneratedCodeCleanupError} from "./src/isolate/NodeGeneratedCode.ts";
import {createHookService} from "./src/hooks/HookService.ts";
import {ChildWorkerCapacity} from "./src/computer/ChildWorkerCapacity.ts";
export default {async fetch(request){
  const mode=new URL(request.url).pathname.slice(1);
  if(mode!=="cooperative"&&mode!=="failed")return new Response("missing",{status:404});
  const program={id:"native-hook",mainModule:"user.js",modules:{"user.js":${JSON.stringify(child)}}};
  const fetcher=createNodeGeneratedCodeFetcher(codeGenerationBinding("capacity-proof/"+mode));
  const invoke=(input,signal)=>fetcher.fetch(new Request("https://code-generation.invalid/invoke",{
    method:"POST",headers:{"content-type":"application/json"},signal,body:JSON.stringify(input),
  }));
  const control=async operation=>await(await invoke({...program,input:{operation}})).json();
  // Plain Worker ceiling from the 2026-10-23 probe; see apps/cloud/src/computer/README.md.
  const capacity=new ChildWorkerCapacity(4,{owner:"test/managed-invocation-capacity"});
  let generatedCalls=0;
  // Only this public invoke-to-Fetcher bridge is test code; no generated cache or SQLite is exercised.
  const service=createHookService({
    capacity,
    commands:{async exec(){throw new Error("Command path must not run");}},
    registrations:new Map([["script",{kind:"script",harness:"claude-code",event:"pre-tool-use",sessionId:"native-session",program}]]),
    generated:{invoke(input,options){generatedCalls++;return invoke(input,options?.signal);}},
  });
  const abort=new AbortController();const reason=new Error("owner stopped hook");
  let settled=false;
  const outcome=service.invoke("script",{mode},{cwd:"/work",env:{},signal:abort.signal}).then(
    ()=>{settled=true;return {unexpectedSuccess:true}},
    error=>{settled=true;return {typedCleanupError:error instanceof NodeGeneratedCodeCleanupError,code:error.code??null,cause:error.cause?String(error.cause):null,sameAbortReason:error===reason}},
  );
  const started=await control("wait-read");const activeWhileReading=capacity.active;
  abort.abort(reason);
  const during=await control("wait-cleanup");
  const activeBeforeAck=capacity.active,settledBeforeAck=settled;
  await control("release");
  const result=await outcome;const activeAfterOutcome=capacity.active;
  const after=await control("status");
  const admissionSignal=new AbortController().signal;
  const additional=[];
  while(capacity.active<capacity.limit)additional.push(await capacity.acquire(admissionSignal));
  const activeAtLimit=capacity.active;
  const queuedAbort=new AbortController(),queuedReason=new Error("cancel queued hook");
  let queuedSettled=false;
  const queued=service.invoke("script",{mode},{cwd:"/work",env:{},signal:queuedAbort.signal}).then(
    ()=>{queuedSettled=true;return {unexpectedSuccess:true}},
    error=>{queuedSettled=true;return {sameAbortReason:error===queuedReason}},
  );
  await Promise.resolve();
  const settledBeforeAbort=queuedSettled;
  queuedAbort.abort(queuedReason);
  const waiting={settledBeforeAbort,...await queued};
  for(const permit of additional)permit.release();
  const activeAfterOtherPermitsRelease=capacity.active;
  const final=await control("status");
  return Response.json({mode,limit:capacity.limit,started,activeWhileReading,during,activeBeforeAck,settledBeforeAck,result,activeAfterOutcome,after,additionalPermits:additional.length,activeAtLimit,waiting,generatedCalls,activeAfterOtherPermitsRelease,final});
}};`;

beforeAll(async () => {
  const base = "/tmp/issue-1066/generated-cancel-work/intrinsics-fix-r4/";
  await NodeFSP.mkdir(base, { recursive: true });
  evidence = await NodeFSP.mkdtemp(NodePath.join(base, "capacity-source-"));
  await NodeFSP.writeFile(NodePath.join(evidence, "host-source.ts"), host);
  await build({
    stdin: {
      contents: host,
      resolveDir: NodePath.resolve(import.meta.dirname, "../.."),
      sourcefile: "retained-capacity-native-host.ts",
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
      name: "generated-retained-capacity-native",
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

async function run(mode: string) {
  const response = await fetch(new URL(`/${mode}`, endpoint), {
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  await NodeFSP.writeFile(
    NodePath.join(evidence, `${mode}.json`),
    JSON.stringify({ status: response.status, body }, null, 2),
  );
  expect(response.status).toBe(200);
  return JSON.parse(body);
}

const common = {
  limit: 10,
  started: {
    runs: 1,
    readStarted: true,
    cancelStarted: false,
    cancelFinished: false,
    cancelRejected: false,
    bodyLocked: true,
  },
  activeWhileReading: 1,
  during: {
    runs: 1,
    readStarted: true,
    cancelStarted: true,
    cancelFinished: false,
    cancelRejected: false,
    bodyLocked: true,
  },
  activeBeforeAck: 1,
  settledBeforeAck: false,
  activeAtLimit: 10,
  waiting: { settledBeforeAbort: false, sameAbortReason: true },
  generatedCalls: 1,
};

describe("native generated hook capacity retention", () => {
  it("holds the shared permit through streaming cleanup and releases it only after acknowledgment", async () => {
    const finished = {
      runs: 1,
      readStarted: true,
      cancelStarted: true,
      cancelFinished: true,
      cancelRejected: false,
      bodyLocked: false,
    };
    expect(await run("cooperative")).toEqual({
      ...common,
      mode: "cooperative",
      result: { typedCleanupError: false, code: null, cause: null, sameAbortReason: true },
      activeAfterOutcome: 0,
      after: finished,
      additionalPermits: 10,
      activeAfterOtherPermitsRelease: 0,
      final: finished,
    });
  });

  it("retains rejected real child cleanup in the ten-slot limit without starting another hook", async () => {
    const unconfirmed = {
      runs: 1,
      readStarted: true,
      cancelStarted: true,
      cancelFinished: false,
      cancelRejected: true,
      bodyLocked: true,
    };
    expect(await run("failed")).toEqual({
      ...common,
      mode: "failed",
      result: {
        typedCleanupError: true,
        code: "CLEANUP_UNCONFIRMED",
        cause: "Error: actual child cleanup rejected",
        sameAbortReason: false,
      },
      activeAfterOutcome: 1,
      after: unconfirmed,
      additionalPermits: 9,
      activeAfterOtherPermitsRelease: 1,
      final: unconfirmed,
    });
  });
});
