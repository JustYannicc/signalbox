// @effect-diagnostics nodeBuiltinImport:off - assembles isolated WASI device proof modules.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";

export async function prepareKernelWasiDevicesProof(
  destination: string,
  artifacts: { readonly bash: string; readonly busybox: string },
): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const programs = [
    ["bash", KERNEL_BASH_ARTIFACT],
    ["busybox", KERNEL_BUSYBOX_ARTIFACT],
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
  await NodeFSP.writeFile(NodePath.join(destination, "device.wasm"), deviceOpenCommandBytes());
  await NodeFSP.writeFile(
    NodePath.join(destination, "device-zero.wasm"),
    deviceOpenCommandBytes(0),
  );
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "wasi-device-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {ABI_VERSION,KernelProgramRegistry} from './kernel/KernelAbi.ts';
export {KernelCpuAccounting} from './kernel/KernelCpuAccounting.ts';
export {KernelCpuExecution} from './kernel/KernelCpuExecution.ts';
export {KernelWakeRegistry} from './kernel/KernelWakeRegistry.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
export {KernelProgramHost} from './kernel/KernelProgramHost.ts';
export {WASI} from './kernel/Wasi.ts';
export {createKernelAsyncWasi} from './kernel/KernelWasi.ts';
export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {createKernelBashProgram,KERNEL_BASH_ARTIFACT} from './kernel/KernelBashProgram.ts';
export {registerKernelBusyboxCat} from './kernel/KernelBusyboxPrograms.ts';
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
  if (!source) throw new Error("WASI device proof bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), source);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    DEVICE_SOURCE.replace("OFFICIAL_BASH_COMMAND_JSON", JSON.stringify(OFFICIAL_BASH_COMMAND)),
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "kernel-wasi-devices-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "WasiDevicesFacet",
        modules: Object.fromEntries([
          ["main.js", { path: "main.js", type: "js" }],
          ["runtime.js", { path: "runtime.js", type: "js" }],
          ["program-bytes.js", { path: "program-bytes.js", type: "js" }],
          ["device.wasm", { path: "device.wasm", type: "wasm" }],
          ["device-zero.wasm", { path: "device-zero.wasm", type: "wasm" }],
          ...programs.map(([name]) => [name + ".wasm", { path: name + ".wasm", type: "wasm" }]),
        ]),
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}

// The probe command exits with the errno from opening dev/null on preopen fd 3.
function deviceOpenCommandBytes(rights: 0 | 2 = 2) {
  const name = (value: string) => {
    const bytes = [...new TextEncoder().encode(value)];
    return [bytes.length, ...bytes];
  };
  // Every fixed section here is shorter than 128 bytes, so its length fits one LEB byte.
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const body = [
    0,
    0x41,
    3,
    0x41,
    0,
    0x41,
    0,
    0x41,
    8,
    0x41,
    0,
    0x42,
    rights,
    0x42,
    0,
    0x41,
    0,
    0x41,
    32,
    0x10,
    0,
    0x10,
    1,
    0x0b,
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
        3, 0x60, 9, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0,
        0x60, 0, 0,
      ],
    ),
    ...section(2, [
      2,
      ...name("wasi_snapshot_preview1"),
      ...name("path_open"),
      0,
      0,
      ...name("wasi_snapshot_preview1"),
      ...name("proc_exit"),
      0,
      1,
    ]),
    ...section(3, [1, 2]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 2]),
    ...section(10, [1, body.length, ...body]),
    ...section(11, [1, 0, 0x41, 0, 0x0b, ...name("dev/null")]),
  ]);
}

const OFFICIAL_BASH_COMMAND = String.raw`shopt -u extglob 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'echo shell-proof > /work/shell.txt && cat /work/shell.txt' < /dev/null && pwd -P >| /tmp/claude-eee1-cwd`;

const DEVICE_SOURCE = String.raw`import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import bash from './bash.wasm';
import busybox from './busybox.wasm';
import device from './device.wasm';
import deviceZero from './device-zero.wasm';
import {encoded} from './program-bytes.js';
import {ABI_VERSION,KernelProgramRegistry,KernelCpuAccounting,KernelCpuExecution,KernelWakeRegistry,KernelFileSystem,KernelProgramHost,WASI,createKernelAsyncWasi,createFacetSqliteStorage,createKernelBashProgram,KERNEL_BASH_ARTIFACT,registerKernelBusyboxCat,createNodeFs,createNodeChildProcess} from './runtime.js';
const credentials={uid:1000,gid:1000,euid:1000,egid:1000};
const env={PATH:'/bin',HOME:'/home/claude',TMPDIR:'/tmp',SHELL:'/bin/bash'};
const command=OFFICIAL_BASH_COMMAND_JSON;
export class WasiDevicesFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.storage=createFacetSqliteStorage(ctx.storage,()=>1800000000000000000n);
    try {this.storage.posix.get(this.storage.root);}catch(error){if(error?.code!=='ENOTSUP')throw error;this.storage.posix.initialize(this.storage.root,{mode:0o755,uid:1000,gid:1000});}
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS wasi_device_proof_calls(n INTEGER)');this.serial=Promise.resolve();
  }
  fetch(){const result=this.serial.then(()=>this.check());this.serial=result.catch(()=>{});return result;}
  async check(){
    const checks={},results={};const kernel=new KernelFileSystem({mounts:[{path:'/',storage:this.storage}],posix:{credentials,umask:0o022}});
    const fs=createNodeFs(kernel).fs;const registry=new KernelProgramRegistry();const wakes=new KernelWakeRegistry();let host,binding;
    try {
      this.ctx.storage.sql.exec('INSERT INTO wasi_device_proof_calls VALUES(1)');
      const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM wasi_device_proof_calls').one().n;
      for(const path of ['/bin','/work','/tmp','/home/claude'])fs.mkdirSync(path,{recursive:true});
      if(calls===1){for(const [path,key] of [['/bin/bash','bash'],['/bin/cat','busybox']])fs.writeFileSync(path,Buffer.from(encoded[key],'base64'),{mode:0o755});}
      checks.programPersistence=[['/bin/bash','bash'],['/bin/cat','busybox']].every(([path,key])=>fs.readFileSync(path).equals(Buffer.from(encoded[key],'base64')));
      const generic=new WASI({version:'preview1',mounts:[{path:'/',storage:this.storage}]});
      try {results.unconfiguredErrno=generic.start(new WebAssembly.Instance(device,generic.getImportObject()));checks.unconfiguredUnchanged=results.unconfiguredErrno===44;}finally{generic.close();}
      binding=createKernelAsyncWasi({filesystem:kernel,wakes});
      const direct=new WebAssembly.Instance(device,binding.wasi.getImportObject());
      results.asyncWasiExit=await binding.wasi.start(direct);checks.asyncWasiDevice=results.asyncWasiExit===0;
      const opened=new DataView(direct.exports.memory.buffer).getUint32(32,true);
      checks.asyncWasiCanonicalDescriptor=fs.fstatSync(opened).isCharacterDevice();fs.closeSync(opened);await binding.wasi.close();binding=undefined;
      for(const persistent of [false,true]) {
        const before=[...kernel.descriptors.entries()].map(([fd])=>fd);
        const failure=new Error('device allocation clock failed');let armed=false,failed=false,caught;
        const execution=new KernelCpuExecution(new KernelCpuAccounting(()=>{
          if(armed&&[...kernel.descriptors.entries()].length>before.length)failed=true;
          if(failed){if(!persistent)failed=false;throw failure;}return 0n;
        }));
        const faultBinding=createKernelAsyncWasi({filesystem:kernel,wakes});
        try {
          const instance=new WebAssembly.Instance(deviceZero,faultBinding.wasi.getImportObject());
          const memory=new DataView(instance.exports.memory.buffer);memory.setUint32(32,123456,true);armed=true;
          try{await execution.root.run(()=>faultBinding.wasi.start(instance));}catch(error){caught=error;}
          armed=false;failed=false;
          checks['clockFailureIdentity'+persistent]=caught===failure;
          checks['unpublishedDeviceReleased'+persistent]=memory.getUint32(32,true)===123456&&JSON.stringify([...kernel.descriptors.entries()].map(([fd])=>fd))===JSON.stringify(before);
        }finally{armed=false;failed=false;execution.root.stop();await faultBinding.wasi.close();}
      }
      const manifest={name:'device-open',version:'1',abiVersion:ABI_VERSION,entrypoint:'device-open-v1',requiredCapabilities:[]};registry.register(manifest);
      const bashManifest={name:'bash',version:KERNEL_BASH_ARTIFACT.version,abiVersion:ABI_VERSION,entrypoint:'bash-device-proof',requiredCapabilities:[]};registry.register(bashManifest);
      const programs=new Map(registerKernelBusyboxCat(registry,busybox));
      programs.set('/bin/device-open',{manifest,implementation:{kind:'wasm',module:device}});
      programs.set('/bin/bash',{manifest:bashManifest,implementation:createKernelBashProgram({module:bash,credentials:{...credentials,umask:0o022}})});
      host=new KernelProgramHost({registry,wakes,programs});
      const resolved=host.resolve('/bin/device-open');if(resolved.status!=='ok')throw new Error('Device command did not resolve');
      const prepared=host.prepare({filesystem:kernel});results.programExit=host.runInline(prepared,resolved.value,[],{});
      checks.directProgramDevice=results.programExit===0;checks.ownedDescriptorsReleased=[...prepared.filesystem.descriptors.entries()].length===0;
      kernel.chdir('/work');const cp=createNodeChildProcess(host,{filesystem:kernel,env});
      results.bash=await new Promise(resolve=>cp.execFile('/bin/bash',['-c','-l',command],{cwd:'/work'},(error,stdout,stderr)=>resolve({error:error?{code:error.code,message:error.message}:null,stdout:String(stdout),stderr:String(stderr)})));
      checks.bashExit=results.bash.error===null;checks.bashOutput=results.bash.stdout==='shell-proof\n'&&results.bash.stderr==='';
      checks.bashShellFile=fs.existsSync('/work/shell.txt')&&fs.readFileSync('/work/shell.txt','utf8')==='shell-proof\n';
      checks.bashCwdFile=fs.existsSync('/tmp/claude-eee1-cwd')&&fs.readFileSync('/tmp/claude-eee1-cwd','utf8')==='/work\n';
      checks.noStoredDeviceDirectory=this.storage.readdir(this.storage.root).every(entry=>entry.name!=='dev');
      checks.resourcesReleased=host.processes.size===0&&wakes.size===0;
      return Response.json({ok:Object.values(checks).every(Boolean),calls,checks,results,note:'Exact Bash command uses the existing pipe route. Original numeric stdio and official release/update execution remain separate.'},{status:Object.values(checks).every(Boolean)?200:500});
    }catch(error){return Response.json({ok:false,checks,results,error:String(error),stack:error.stack},{status:500});}
    finally{await binding?.wasi.close();await host?.processes.dispose();wakes.dispose();kernel.dispose();}
  }
}
`;
