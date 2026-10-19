// @effect-diagnostics nodeBuiltinImport:off - assembles isolated subprocess proof modules.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";

export async function prepareNodeChildProcessProof(
  destination: string,
  artifacts: { readonly bash: string; readonly busybox: string; readonly ripgrep: string },
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
      throw new Error(`${name} proof artifact does not match its source pin`);
    await NodeFSP.writeFile(NodePath.join(destination, `${name}.wasm`), bytes);
    encoded[name] = bytes.toString("base64");
  }
  await NodeFSP.writeFile(
    NodePath.join(destination, "program-bytes.js"),
    `export const encoded = ${JSON.stringify(encoded)};\n`,
  );
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "child-process-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {ABI_VERSION,KernelProgramRegistry} from './kernel/KernelAbi.ts';
export {KernelWakeRegistry} from './kernel/KernelWakeRegistry.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
export {KernelProgramHost} from './kernel/KernelProgramHost.ts';
export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {createKernelBashProgram,KERNEL_BASH_ARTIFACT} from './kernel/KernelBashProgram.ts';
export {registerKernelBusyboxCat} from './kernel/KernelBusyboxPrograms.ts';
export {createKernelRipgrepProgram,KERNEL_RIPGREP_PROGRAM_MANIFEST} from './kernel/KernelRipgrepProgram.ts';
export {createNodeFs} from './isolate/NodeFs.ts';
export {createNodeChildProcess} from './isolate/NodeChildProcess.ts';`,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    write: false,
  });
  const source = runtime.outputFiles?.[0]?.text;
  if (!source) throw new Error("Subprocess proof bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), source);
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), CHILD_PROCESS_SOURCE);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-child-stdio-real-programs-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "ChildProcessFacet",
        modules: Object.fromEntries(
          [
            ["main.js", "js"],
            ["runtime.js", "js"],
            ["program-bytes.js", "js"],
            ...programs.map(([name]) => [`${name}.wasm`, "wasm"]),
          ].map(([name, type]) => [name, { path: name, type }]),
        ),
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}

const CHILD_PROCESS_SOURCE = String.raw`import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import bash from './bash.wasm';
import busybox from './busybox.wasm';
import ripgrep from './ripgrep.wasm';
import {encoded} from './program-bytes.js';
import {ABI_VERSION,KernelProgramRegistry,KernelWakeRegistry,KernelFileSystem,KernelProgramHost,createFacetSqliteStorage,createKernelBashProgram,KERNEL_BASH_ARTIFACT,registerKernelBusyboxCat,createKernelRipgrepProgram,KERNEL_RIPGREP_PROGRAM_MANIFEST,createNodeFs,createNodeChildProcess} from './runtime.js';
const credentials={uid:1000,gid:1000,euid:1000,egid:1000};
const env={PATH:'/bin',HOME:'/home/claude',TMPDIR:'/tmp',SHELL:'/bin/bash'};
function run(child) {
  let stdout='',stderr='',error;const events=[];
  child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
  child.stdout?.on('data',value=>{stdout+=value;});child.stderr?.on('data',value=>{stderr+=value;});
  child.on('spawn',()=>events.push('spawn'));child.on('exit',()=>events.push('exit'));
  child.on('error',value=>{error={code:value.code,message:value.message};events.push('error');});
  const result=new Promise(resolve=>child.once('close',(code,signal)=>{events.push('close');resolve({code,signal,stdout,stderr,error,events});}));
  child.stdin?.end();return result;
}
export class ChildProcessFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.storage=createFacetSqliteStorage(ctx.storage,()=>1800000000000000000n);
    try {this.storage.posix.get(this.storage.root);}catch(error){if(error?.code!=='ENOTSUP')throw error;this.storage.posix.initialize(this.storage.root,{mode:0o755,uid:1000,gid:1000});}
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS child_stdio_proof_calls(n INTEGER)');this.serial=Promise.resolve();
  }
  fetch(){const result=this.serial.then(()=>this.check());this.serial=result.catch(()=>{});return result;}
  async check(){
    const checks={},results={};const kernel=new KernelFileSystem({mounts:[{path:'/',storage:this.storage}],posix:{credentials,umask:0o022}});
    const fs=createNodeFs(kernel).fs;const registry=new KernelProgramRegistry();const wakes=new KernelWakeRegistry();let host;
    try {
      this.ctx.storage.sql.exec('INSERT INTO child_stdio_proof_calls VALUES(1)');
      const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM child_stdio_proof_calls').one().n;
      for(const path of ['/bin','/work','/tmp','/home/claude'])fs.mkdirSync(path,{recursive:true});
      if(calls===1){for(const [path,key] of [['/bin/bash','bash'],['/bin/rg','ripgrep'],['/bin/cat','busybox']]){fs.writeFileSync(path,Buffer.from(encoded[key],'base64'),{mode:0o755});}}
      checks.programPersistence=[['/bin/bash','bash'],['/bin/rg','ripgrep'],['/bin/cat','busybox']].every(([path,key])=>fs.readFileSync(path).equals(Buffer.from(encoded[key],'base64')));
      fs.writeFileSync('/work/source.txt','initial line\nneedle-after\n');fs.writeFileSync('/work/new.txt','written from Claude\n');kernel.chdir('/work');
      const bashManifest={name:'bash',version:KERNEL_BASH_ARTIFACT.version,abiVersion:ABI_VERSION,entrypoint:'bash-child-stdio-proof',requiredCapabilities:[]};
      registry.register(bashManifest);registry.register(KERNEL_RIPGREP_PROGRAM_MANIFEST);
      const programs=new Map(registerKernelBusyboxCat(registry,busybox));
      programs.set('/bin/bash',{manifest:bashManifest,implementation:createKernelBashProgram({module:bash,credentials:{...credentials,umask:0o022}})});
      programs.set('/bin/rg',{manifest:KERNEL_RIPGREP_PROGRAM_MANIFEST,implementation:createKernelRipgrepProgram({module:ripgrep})});
      host=new KernelProgramHost({registry,wakes,programs});const cp=createNodeChildProcess(host,{filesystem:kernel,env});
      const defaults=cp.spawn('/bin/rg',['--version'],{stdio:[undefined,undefined,undefined]});results.defaults=await run(defaults);
      checks.defaultSlots=results.defaults.code===0 && results.defaults.stdout.includes('ripgrep 15.1.0') && results.defaults.stderr==='';
      const ignored=cp.spawn('/bin/rg',['--files','--hidden','/work'],{stdio:['ignore','pipe','ignore']});
      checks.ignoredNullStreams=ignored.stdin===null && ignored.stderr===null && ignored.stdio[0]===null && ignored.stdio[2]===null;
      results.ignored=await run(ignored);checks.ignoredFiles=results.ignored.code===0 && results.ignored.stdout.includes('/work/source.txt') && results.ignored.stdout.includes('/work/new.txt');
      const directory=fs.openSync('/work',2048);
      try {
        const grep=['--hidden','--glob','!.git','--glob','!.svn','--glob','!.hg','--glob','!.bzr','--glob','!.jj','--glob','!.sl','--max-columns','500','--json','-n','needle-after','.'];
        results.grep=await run(cp.spawn('/bin/rg',grep,{cwd:'/proc/self/fd/'+directory}));
        checks.procFdCwd=results.grep.code===0 && results.grep.stdout.includes('needle-after') && results.grep.stderr==='';
      } finally {fs.closeSync(directory);}
      const fd=fs.openSync('/work/redirected','w+');fs.writeSync(fd,'prefix:');
      try {
        const child=cp.spawn('/bin/bash',['-c','printf out; printf err >&2'],{stdio:['ignore',fd,fd]});
        checks.numericNullStreams=child.stdin===null && child.stdout===null && child.stderr===null;
        results.redirected=await run(child);checks.numericSharedOffset=results.redirected.code===0 && fs.readFileSync('/work/redirected','utf8')==='prefix:outerr' && fs.readSync(fd,new Uint8Array(1),0,1,null)===0;
        checks.parentDescriptorAlive=fs.fstatSync(fd).isFile();
      } finally {fs.closeSync(fd);}
      const detached=fs.openSync('/work/parent-closed','w+');const owned=cp.spawn('/bin/bash',['-c','printf retained; printf alias >&2'],{stdio:['ignore',detached,detached]});const ownedResult=run(owned);fs.closeSync(detached);
      results.parentClosed=await ownedResult;checks.parentCloseRetained=results.parentClosed.code===0 && fs.readFileSync('/work/parent-closed','utf8')==='retainedalias';
      results.closed=await run(cp.spawn('/bin/rg',['--version'],{stdio:['ignore',999999,999999]}));
      checks.closedDescriptor=results.closed.error?.code==='EBADF' && results.closed.events.at(-1)==='close';
      checks.eventOrder=results.defaults.events.join(',')==='spawn,exit,close' && results.redirected.events.join(',')==='spawn,exit,close';
      checks.resourcesReleased=host.processes.size===0 && wakes.size===0;
      const ok=Object.values(checks).every(Boolean);return Response.json({ok,calls,checks,results,note:'Public child bridge and pinned programs. Official release execution and update proof remain separate.'},{status:ok?200:500});
    }catch(error){return Response.json({ok:false,checks,results,error:String(error),stack:error.stack},{status:500});}
    finally {await host?.processes.dispose();wakes.dispose();kernel.dispose();}
  }
}
`;
