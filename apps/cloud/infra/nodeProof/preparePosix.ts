// @effect-diagnostics nodeBuiltinImport:off - Builds isolated SQL filesystem proof modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

export async function prepareNodePosixProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "posix-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {KernelFileSystem,KernelOpenFlags} from './kernel/KernelFileSystem.ts';
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
  if (!runtimeSource) throw new Error("POSIX proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import {DurableObject} from 'cloudflare:workers';
import {createFacetSqliteStorage,KernelFileSystem,KernelOpenFlags,createNodeFs} from './runtime.js';
const credentials={uid:1000,gid:1000,euid:1000,egid:1000};
const policy={credentials,umask:0o022};
const code=error=>error && typeof error==='object' ? error.code : undefined;
async function rejects(callback,expected) {try {await callback();return false;}catch(error){return code(error)===expected;}}
function fails(callback,expected) {try {callback();return false;}catch(error){return code(error)===expected;}}
export class NodePosixFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.storage=createFacetSqliteStorage(ctx.storage,()=>1800000000000000000n);
    try {this.storage.posix.get(this.storage.root);}
    catch(error) {if(code(error)!=='ENOTSUP')throw error;this.storage.posix.initialize(this.storage.root,{mode:0o755,uid:1000,gid:1000});}
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_posix_proof_calls(n INTEGER)');
    this.serial=Promise.resolve();
  }
  fetch() {const result=this.serial.then(()=>this.check());this.serial=result.catch(()=>{});return result;}
  async check() {
    const checks={};
    const kernel=new KernelFileSystem({mounts:[{path:'/',storage:this.storage}],posix:policy});
    const fs=createNodeFs(kernel).fs;
    try {
      this.ctx.storage.sql.exec('INSERT INTO node_posix_proof_calls VALUES(1)');
      const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM node_posix_proof_calls').one().n;
      fs.mkdirSync('/work',{recursive:true});
      if(calls===1)fs.writeFileSync('/work/persistent','real SQL permissions',{mode:0o640});
      checks.persistence=fs.readFileSync('/work/persistent','utf8')==='real SQL permissions' &&
        fs.statSync('/work/persistent').mode===0o100640;
      const path='/work/run-'+calls;
      fs.mkdirSync(path);
      fs.writeFileSync(path+'/source','before',{mode:0o640});
      const original=await fs.promises.lstat(path+'/source');
      checks.numericStats=original.mode===0o100640 && original.uid===1000 && original.gid===1000;
      const big=await fs.promises.stat(path+'/source',{bigint:true});
      checks.bigintStats=big.mode===0o100640n && big.uid===1000n && big.gid===1000n;
      fs.symlinkSync('source',path+'/link');
      checks.symlinkMetadata=fs.lstatSync(path+'/link').mode===0o120777 &&
        fs.statSync(path+'/link').mode===0o100640;
      const directory=await fs.promises.open(path,2048);
      const proc='/proc/self/fd/'+directory.fd;
      const temp=proc+'/source.tmp';
      const file=await fs.promises.open(temp,131265,0o600);
      try {
        await file.writeFile('after');
        await file.chmod(original.mode);
        checks.chmodPreservesPermissions=kernel.getPosixMetadataForFd(file.fd).mode===0o640;
        const metadata=await file.stat();
        checks.fileHandleStats=metadata.mode===0o100640 && metadata.uid===1000 && metadata.gid===1000;
        await file.sync();
      } finally {await file.close();}
      await fs.promises.rename(temp,path+'/source');
      checks.atomicEdit=fs.readFileSync(path+'/source','utf8')==='after' &&
        kernel.getPosixMetadata(path+'/source').mode===0o640;
      await fs.promises.access(proc,1);
      fs.accessSync(proc,1);
      checks.executeAccess=true;
      checks.callbackAccess=await new Promise(resolve=>fs.access(proc,1,error=>resolve(error===null)));
      kernel.chmod(path,0);
      checks.deniedExecute=await rejects(()=>fs.promises.access(proc,1),'EACCES') &&
        fails(()=>fs.accessSync(proc,1),'EACCES');
      await fs.promises.access(proc,0);
      checks.existenceWithoutExecute=true;
      kernel.chmod(path,0o755);
      await directory.close();
      checks.closedAccess=await rejects(()=>fs.promises.access(proc,1),'ENOENT');
      const invalid=await fs.promises.open(path+'/source','r+');
      try {checks.invalidMode=await rejects(()=>invalid.chmod(-1),'ERR_OUT_OF_RANGE') &&
        kernel.getPosixMetadataForFd(invalid.fd).mode===0o640;}
      finally {await invalid.close();}
      checks.closedChmod=await rejects(()=>invalid.chmod(0o777),'EBADF');
      const readonly=new KernelFileSystem({mounts:[{path:'/',storage:this.storage,readOnly:true}],posix:policy});
      try {
        const handle=await createNodeFs(readonly).fs.promises.open(path+'/source','r');
        try {checks.readonly=await rejects(()=>handle.chmod(0o777),'EROFS');}
        finally {await handle.close();}
      } finally {readonly.dispose();}
      const other=new KernelFileSystem({mounts:[{path:'/',storage:this.storage}],posix:{credentials:{uid:2000,gid:2000,euid:2000,egid:2000},umask:0o022}});
      try {
        const otherFs=createNodeFs(other).fs;
        const handle=await otherFs.promises.open(path+'/source','r+');
        try {checks.ownerRequired=await rejects(()=>handle.chmod(0o777),'EPERM');}
        finally {await handle.close();}
        checks.realAccessDenied=await rejects(()=>otherFs.promises.access(path+'/source',4),'EACCES');
      } finally {other.dispose();}
      const virtual=fs.statSync('/dev/null');
      checks.virtualUnknown=virtual.mode===0o020000 && virtual.uid===-1 && virtual.gid===-1;
      const ok=Object.values(checks).every(Boolean);
      return Response.json({ok,calls,checks,note:'Canonical POSIX metadata, FileHandle chmod and Node access. Official release tools and shell execution are separate.'},{status:ok?200:500});
    } catch(error) {return Response.json({ok:false,checks,error:String(error),stack:error.stack},{status:500});}
    finally {kernel.dispose();}
  }
}
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-posix-metadata-chmod-access-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodePosixFacet",
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
