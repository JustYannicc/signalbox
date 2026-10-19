// @effect-diagnostics nodeBuiltinImport:off - assembles an isolated native Worker proof fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";

export interface AsyncWasiCpuProofInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly unknown[];
}

function validateInvocation(call: AsyncWasiCpuProofInvocation) {
  if (
    call.argv.length !== 3 ||
    call.argv[0] !== "-c" ||
    call.argv[1] !== "-l" ||
    call.cwd !== "/work" ||
    JSON.stringify(call.stdio) !== JSON.stringify(["pipe", 302, 302]) ||
    !call.argv[2]?.includes("echo shell-proof > /work/shell.txt && cat /work/shell.txt") ||
    !call.argv[2]?.includes("pwd -P >| /tmp/claude-f5a3-cwd")
  )
    throw new Error("Bash invocation does not match the CPU proof case");
  const env = { ...call.env, LC_ALL: "C.UTF-8" };
  if (!call.env.HOME || !call.env.PATH?.split(":").includes("/bin"))
    throw new Error("Bash environment needs a usable HOME and /bin PATH entry");
  return { argv: call.argv, cwd: call.cwd, env };
}

export async function prepareAsyncWasiCpuProof(
  destination: string,
  artifacts: { readonly bash: string; readonly busybox: string; readonly ripgrep: string },
  call: AsyncWasiCpuProofInvocation,
): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const programs = [
    ["bash", KERNEL_BASH_ARTIFACT],
    ["busybox", KERNEL_BUSYBOX_ARTIFACT],
    ["ripgrep", KERNEL_RIPGREP_ARTIFACT],
  ] as const;
  const encoded: Record<string, string> = {};
  for (const [name, pin] of programs) {
    const bytes = await NodeFSP.readFile(artifacts[name]);
    if (
      bytes.byteLength !== pin.bytes ||
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
    )
      throw new Error(name + " proof artifact does not match its source pin");
    await NodeFSP.writeFile(NodePath.join(destination, name + ".wasm"), bytes);
    encoded[name] = bytes.toString("base64");
  }
  await NodeFSP.writeFile(
    NodePath.join(destination, "program-bytes.js"),
    "export const encoded = " + JSON.stringify(encoded) + ";\n",
  );

  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "async-wasi-cpu-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: [
        "export {ABI_VERSION,KernelProgramRegistry} from './kernel/KernelAbi.ts';",
        "export {KernelCpuAccounting} from './kernel/KernelCpuAccounting.ts';",
        "export {KernelWakeRegistry} from './kernel/KernelWakeRegistry.ts';",
        "export {KernelFileSystem} from './kernel/KernelFileSystem.ts';",
        "export {KernelProgramHost} from './kernel/KernelProgramHost.ts';",
        "export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';",
        "export {createKernelBashProgram,KERNEL_BASH_ARTIFACT} from './kernel/KernelBashProgram.ts';",
        "export {registerKernelBusyboxCat} from './kernel/KernelBusyboxPrograms.ts';",
        "export {createKernelRipgrepProgram,KERNEL_RIPGREP_PROGRAM_MANIFEST} from './kernel/KernelRipgrepProgram.ts';",
        "export {createNodeFs} from './isolate/NodeFs.ts';",
        "export {createNodeChildProcess} from './isolate/NodeChildProcess.ts';",
      ].join("\n"),
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Async WASI CPU proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);

  const invocation = validateInvocation(call);
  const invocationJson = JSON.stringify(invocation);
  if (!invocationJson) throw new Error("Official Bash invocation could not be serialized");
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    MAIN_SOURCE.replace("__OFFICIAL_INVOCATION_JSON__", invocationJson),
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-async-wasi-cpu-fork-completion-v1",
        mode: "facet",
        allowOutbound: false,
        mainModule: "main.js",
        entrypoint: "AsyncWasiCpuFacet",
        modules: Object.fromEntries([
          ["main.js", { path: "main.js", type: "js" }],
          ["runtime.js", { path: "runtime.js", type: "js" }],
          ["program-bytes.js", { path: "program-bytes.js", type: "js" }],
          ...programs.map(([name]) => [name + ".wasm", { path: name + ".wasm", type: "wasm" }]),
        ]),
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}

const MAIN_SOURCE = String.raw`import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import * as NativeProcess from 'node:process';
import bash from './bash.wasm';
import busybox from './busybox.wasm';
import ripgrep from './ripgrep.wasm';
import {encoded} from './program-bytes.js';
import {ABI_VERSION,KernelProgramRegistry,KernelCpuAccounting,KernelWakeRegistry,
  KernelFileSystem,KernelProgramHost,createFacetSqliteStorage,createKernelBashProgram,
  KERNEL_BASH_ARTIFACT,registerKernelBusyboxCat,createKernelRipgrepProgram,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,createNodeFs,createNodeChildProcess} from './runtime.js';

const readClock=NativeProcess.hrtime.bigint.bind(NativeProcess.hrtime);
const invocation=__OFFICIAL_INVOCATION_JSON__;
const credentials={uid:1000,gid:1000,euid:1000,egid:1000};
const files=[['/bin/bash','bash'],['/bin/cat','busybox'],['/bin/rg','ripgrep']];
const shellFile='/work/shell.txt',outputFile='/work/output',cwdFile='/tmp/claude-f5a3-cwd';
const expectedOutput=Buffer.from('shell-proof\n'),expectedCwd=Buffer.from('/work\n');

function run(child) {
  const errors=[];let stdout='',stderr='';
  child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
  child.stdout?.on('data',value=>{stdout+=value;});child.stderr?.on('data',value=>{stderr+=value;});
  child.on('error',error=>errors.push({code:error.code??null,message:error.message}));
  return new Promise(resolve=>{
    child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,errors,
      stdio:[child.stdin===null?null:'pipe',child.stdout===null?null:'pipe',child.stderr===null?null:'pipe']}));
    child.stdin?.end();
  });
}
// Deployed Worker clocks stay fixed during CPU-only execution.
function readable(snapshot) {return snapshot!==undefined&&snapshot.userNs>=0n&&snapshot.systemNs>=0n;}
function stopped(cpu) {
  try {cpu.runUser(()=>undefined);return false;}
  catch(error) {return error.message==='CPU process execution is stopped';}
}
function encodeSnapshot(snapshot) {return snapshot===undefined?null:{userNs:String(snapshot.userNs),systemNs:String(snapshot.systemNs)};}
function sameBytes(fs,path,expected) {return fs.existsSync(path)&&fs.readFileSync(path).equals(expected);}

function createProofHost(wakes,clock,getCapture) {
  const registry=new KernelProgramRegistry();
    const bashManifest={name:'bash',version:KERNEL_BASH_ARTIFACT.version,abiVersion:ABI_VERSION,
      entrypoint:'bash-async-cpu-proof',requiredCapabilities:[]};
    if(registry.register(bashManifest).status!=='ok')throw new Error('Bash registration failed');
    if(registry.register(KERNEL_RIPGREP_PROGRAM_MANIFEST).status!=='ok')throw new Error('ripgrep registration failed');
    const programs=new Map(registerKernelBusyboxCat(registry,busybox));
    programs.set('/bin/bash',{manifest:bashManifest,
      implementation:createKernelBashProgram({module:bash,credentials:{...credentials,umask:0o022}})});
    programs.set('/bin/rg',{manifest:KERNEL_RIPGREP_PROGRAM_MANIFEST,
      implementation:createKernelRipgrepProgram({module:ripgrep})});
    const host=new KernelProgramHost({registry,wakes,programs,
      cpuAccounting:new KernelCpuAccounting(clock)});
    const originalSpawn=host.processes.spawn.bind(host.processes);
    host.processes.spawn=(parent,launch,release,options)=>originalSpawn(parent,identity=>{
      const child=launch(identity);
      const capture=getCapture();
      if(capture) {
        const parentInfo=host.processes.info(parent),cpu=host.cpuExecution?.forProcess(identity.pid);
        const record={pid:identity.pid,parentPid:parentInfo.status==='ok'?parentInfo.value.pid:0,cpu,live:undefined};
        capture.push(record);
        // Attach before process-table completion handling and return the original child unchanged.
        const captureLive=()=>{record.live=cpu?.snapshot();};void child.completion.then(captureLive,captureLive);
      }
      return child;
    },release,options);
  return host;
}

export class AsyncWasiCpuFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.storage=createFacetSqliteStorage(ctx.storage,readClock);
    try {this.storage.posix.get(this.storage.root);}catch(error) {
      if(error?.code!=='ENOTSUP')throw error;
      this.storage.posix.initialize(this.storage.root,{mode:0o755,uid:1000,gid:1000});
    }
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS async_wasi_cpu_requests(n INTEGER)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS async_wasi_cpu_installs(n INTEGER)');
    this.wakes=new KernelWakeRegistry();this.capture=undefined;
    this.host=createProofHost(this.wakes,readClock,()=>this.capture);
    this.serial=Promise.resolve();
  }

  fetch(request) {
    const path=new URL(request.url).pathname;
    if(path!=='/status'&&path!=='/again')return new Response('Not found',{status:404});
    const response=this.serial.then(()=>this.check(path));this.serial=response.catch(()=>{});return response;
  }

  async check(path) {
    const checks={},results={},captures=[];
    const filesystem=new KernelFileSystem({mounts:[{path:'/',storage:this.storage}],
      posix:{credentials,umask:0o022}});
    const fs=createNodeFs(filesystem).fs;this.capture=captures;let failed=false;
    try {
      this.ctx.storage.sql.exec('INSERT INTO async_wasi_cpu_requests VALUES(1)');
      const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM async_wasi_cpu_requests').one().n;
      for(const dir of ['/bin','/work','/tmp','/home/claude'])fs.mkdirSync(dir,{recursive:true});
      if(calls===1) {
        for(const [file,key] of files)fs.writeFileSync(file,Buffer.from(encoded[key],'base64'),{mode:0o755});
        this.ctx.storage.sql.exec('INSERT INTO async_wasi_cpu_installs VALUES(1)');
      }
      const installations=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM async_wasi_cpu_installs').one().n;
      checks.requestOrder=(calls===1&&path==='/status')||(calls===2&&path==='/again');
      checks.programsInstalledOnce=installations===1;
      checks.programBytesPersisted=files.every(([file,key])=>
        fs.readFileSync(file).equals(Buffer.from(encoded[key],'base64')));
      filesystem.chdir('/work');
      if(calls===1&&path==='/status') {
        const before=readClock();
        await this.runInitialProof(this.host,fs,filesystem,checks,results,captures);
        results.nativeClock={beforeNs:String(before),afterNs:String(readClock()),
          note:'Native host clock; zero deltas remain zero, including deployed CPU-only execution.'};
        const controlledChecks={},controlledResults={},controlledCaptures=[];
        const controlledWakes=new KernelWakeRegistry();let clockNs=0n;
        const controlledHost=createProofHost(controlledWakes,()=>++clockNs,()=>controlledCaptures);
        try {
          await this.runInitialProof(controlledHost,fs,filesystem,controlledChecks,controlledResults,controlledCaptures);
          for(const key of ['bash','forkChild']) {
            const counter=controlledResults.cpu[key].final;
            controlledChecks[key+'CpuPositive']=!!counter&&BigInt(counter.userNs)>0n&&BigInt(counter.systemNs)>0n;
          }
          controlledChecks.resourcesReleased=controlledHost.processes.size===0&&controlledWakes.size===0;
          checks.deterministicAccounting=Object.values(controlledChecks).every(Boolean);
          results.accountingControl={clock:'injected one-nanosecond increment per read',
            checks:controlledChecks,cpu:controlledResults.cpu};
        } finally {await controlledHost.processes.dispose();controlledWakes.dispose();}
      } else if(calls===2&&path==='/again') {
        checks.previousCallSucceeded=this.firstRun?.ok===true;
        checks.shellFilePersistedAcrossRequest=sameBytes(fs,shellFile,expectedOutput);
        checks.outputFilePersistedAcrossRequest=sameBytes(fs,outputFile,expectedOutput);
        checks.cwdFilePersistedAcrossRequest=sameBytes(fs,cwdFile,Buffer.from('/work\n'));
        results.previousRun=this.firstRun?.results??null;
      }
      checks.resourcesReleased=this.host.processes.size===0&&this.wakes.size===0;
      const ok=Object.values(checks).every(Boolean);if(calls===1)this.firstRun={ok,results};
      return Response.json({ok,calls,path,checks,results,
        note:'Static Wasm imports, pinned real programs, and one persistent SQLite filesystem.'},{status:ok?200:500});
    } catch(error) {
      failed=true;return Response.json({ok:false,path,checks,results,error:String(error),stack:error?.stack??null},{status:500});
    } finally {
      this.capture=undefined;if(failed)await this.host.processes.dispose();filesystem.dispose();
    }
  }

  async runInitialProof(host,fs,filesystem,checks,results,captures) {
    const descriptor=fs.openSync(outputFile,'w');filesystem.descriptors.put(302,filesystem.descriptors.take(descriptor));
    const childProcess=createNodeChildProcess(host,{filesystem,env:invocation.env});
    const bash=childProcess.spawn('/bin/bash',invocation.argv,
      {cwd:invocation.cwd,env:invocation.env,stdio:['pipe',302,302]});
    results.bash=await run(bash);
    results.invocation={argv:invocation.argv,cwd:invocation.cwd,
      env:{HOME:invocation.env.HOME,PATH:invocation.env.PATH,LC_ALL:invocation.env.LC_ALL},stdio:['pipe',302,302]};
    checks.bashExit=results.bash.code===0&&results.bash.signal===null&&results.bash.errors.length===0;
    checks.bashNoEio=results.bash.errors.every(error=>error.code!=='EIO');
    checks.numericStdio=results.bash.stdio[0]==='pipe'&&results.bash.stdio[1]===null&&results.bash.stdio[2]===null;
    checks.shellBytes=sameBytes(fs,shellFile,expectedOutput);checks.outputBytes=sameBytes(fs,outputFile,expectedOutput);
    checks.cwdFileBytes=sameBytes(fs,cwdFile,expectedCwd);checks.parent302Alive=fs.fstatSync(302).isFile();

    results.defaultStdioBash=await run(childProcess.spawn('/bin/bash',['-c',':'],{cwd:'/work',env:invocation.env}));
    checks.defaultStdioBashExit=results.defaultStdioBash.code===0&&
      results.defaultStdioBash.signal===null&&results.defaultStdioBash.errors.length===0;
    const bashProcess=captures.find(record=>record.parentPid===1&&captures.some(child=>child.parentPid===record.pid));
    const forkChild=bashProcess&&captures.find(record=>record.parentPid===bashProcess.pid);
    const bashFinal=bashProcess?.cpu?.snapshot(),childFinal=forkChild?.cpu?.snapshot();
    checks.bashForkChildObserved=!!bashProcess&&!!forkChild&&bashProcess.pid!==forkChild.pid;
    checks.cpuCapturedBeforeStop=!!bashProcess?.live&&!!forkChild?.live;
    checks.parentCpuReadable=readable(bashFinal);checks.forkChildCpuReadable=readable(childFinal);
    checks.cpuOwnersDistinct=!!bashProcess?.cpu&&!!forkChild?.cpu&&bashProcess.cpu!==forkChild.cpu;
    checks.parentCpuStopped=!!bashProcess?.cpu&&stopped(bashProcess.cpu);
    checks.forkChildCpuStopped=!!forkChild?.cpu&&stopped(forkChild.cpu);
    results.cpu={
      bash:{pid:bashProcess?.pid??null,live:encodeSnapshot(bashProcess?.live),final:encodeSnapshot(bashFinal)},
      forkChild:{pid:forkChild?.pid??null,live:encodeSnapshot(forkChild?.live),final:encodeSnapshot(childFinal)}
    };
    fs.closeSync(302);
  }
}
`;
