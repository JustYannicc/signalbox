// @effect-diagnostics nodeBuiltinImport:off - Builds isolated SQL filesystem proof modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

export async function prepareNodeNonblockingProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "nonblocking-runtime.ts",
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
  if (!runtimeSource) throw new Error("Nonblocking proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import {DurableObject} from 'cloudflare:workers';
import {createFacetSqliteStorage,KernelFileSystem,KernelOpenFlags,createNodeFs} from './runtime.js';
const bytes=value=>new TextEncoder().encode(value);
const decoder=new TextDecoder();
function fails(callback,code) {
  try {callback();return false;} catch(error) {return error.code===code;}
}
async function rejects(callback,code) {
  try {await callback();return false;} catch(error) {return error.code===code;}
}
export class NonblockingFilesystemFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.storage=createFacetSqliteStorage(ctx.storage,()=>1800000000000000000n);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nonblocking_proof_calls(n INTEGER)');
    this.serial=Promise.resolve();
  }
  fetch() {
    const result=this.serial.then(()=>this.check());
    this.serial=result.catch(()=>{});
    return result;
  }
  async check() {
    const checks={};
    const kernel=new KernelFileSystem({mounts:[{path:'/',storage:this.storage}],stdio:[
      {readInto:()=>0},{write:source=>source.byteLength},{write:source=>source.byteLength}]});
    try {
      this.ctx.storage.sql.exec('INSERT INTO nonblocking_proof_calls VALUES(1)');
      const calls=this.ctx.storage.sql.exec('SELECT count(*) AS n FROM nonblocking_proof_calls').one().n;
      const fs=createNodeFs(kernel).fs;
      fs.mkdirSync('/work',{recursive:true});
      if(calls===1)fs.writeFileSync('/work/persistent','stored in SQL');
      checks.persistence=fs.readFileSync('/work/persistent','utf8')==='stored in SQL';
      const directory='/work/run-'+calls;
      fs.mkdirSync(directory);
      fs.writeFileSync(directory+'/source.txt','source bytes');
      const anchor=fs.openSync(directory,KernelOpenFlags.O_PATH|KernelOpenFlags.O_DIRECTORY);
      const prefix='/proc/self/fd/'+anchor;
      const handle=await fs.promises.open(prefix+'/source.txt',657664);
      checks.exactFlagsRead=await handle.readFile('utf8')==='source bytes';
      const descriptor=kernel.descriptors.get(handle.fd);
      checks.statusAndCloseOnExec=descriptor.flags===4 && descriptor.closeOnExec;
      checks.readRights=fails(()=>kernel.write(handle.fd,bytes('blocked'),0n),'EBADF');
      await handle.close();
      checks.missingLeaf=await rejects(()=>fs.promises.open(prefix+'/new.txt',657664),'ENOENT');
      fs.writeFileSync(prefix+'/new.txt','created through anchor');
      fs.renameSync(prefix+'/new.txt',prefix+'/renamed.txt');
      checks.createRename=fs.readFileSync(directory+'/renamed.txt','utf8')==='created through anchor';
      fs.unlinkSync(prefix+'/renamed.txt');
      checks.unlink=!fs.existsSync(directory+'/renamed.txt');
      fs.symlinkSync('source.txt',directory+'/link.txt');
      checks.noFollowLeaf=await rejects(()=>fs.promises.open(prefix+'/link.txt',657664),'ELOOP');
      checks.noFollowMagic=fails(()=>fs.openSync(prefix,657664),'ELOOP');
      const directoryHandle=await fs.promises.open(directory,2048);
      checks.exactDirectoryFlags=(await directoryHandle.stat()).isDirectory() &&
        kernel.descriptors.get(directoryHandle.fd).flags===4;
      await directoryHandle.close();
      const fileAnchor=fs.openSync(directory+'/source.txt',KernelOpenFlags.O_PATH);
      checks.nonDirectoryAnchor=fails(()=>fs.openSync('/proc/self/fd/'+fileAnchor+'/child',657664),'ENOTDIR');
      fs.closeSync(fileAnchor);
      fs.mkdirSync(directory+'/old/sub',{recursive:true});
      fs.writeFileSync(directory+'/old/sub/leaf','anchored');
      const retained=fs.openSync(directory+'/old/sub',KernelOpenFlags.O_PATH|KernelOpenFlags.O_DIRECTORY);
      fs.renameSync(directory+'/old',directory+'/new');
      checks.renameRefresh=fs.readFileSync('/proc/self/fd/'+retained+'/leaf','utf8')==='anchored';
      fs.mkdirSync(directory+'/other');
      fs.renameSync(directory+'/new',directory+'/other/moved');
      checks.staleAncestor=fails(()=>fs.openSync('/proc/self/fd/'+retained+'/leaf',657664),'ESTALE');
      fs.closeSync(retained);
      fs.closeSync(anchor);
      checks.closedAnchor=await rejects(()=>fs.promises.open(prefix+'/source.txt',657664),'ENOENT');
      const ordinary=kernel.open(directory+'/source.txt',KernelOpenFlags.O_RDWR|KernelOpenFlags.O_NONBLOCK);
      const duplicate=kernel.descriptors.duplicate(ordinary);
      const first=new Uint8Array(6),second=new Uint8Array(6);
      checks.sharedOffset=kernel.read(ordinary,first,null)===6 && kernel.read(duplicate,second,null)===6 &&
        decoder.decode(first)==='source' && decoder.decode(second)===' bytes';
      checks.sharedStatus=kernel.descriptors.get(duplicate).flags===4;
      checks.ordinaryEof=kernel.read(ordinary,new Uint8Array(1),null)===0;
      kernel.close(ordinary);kernel.close(duplicate);
      checks.streamsUnsupported=fails(()=>kernel.open('/proc/self/fd/0',2048),'ENOTSUP');
      checks.devicesUnsupported=['/dev/null','/dev/zero','/dev/random'].every(path=>fails(()=>kernel.open(path,2048),'ENOTSUP'));
      checks.directoryRestrictions=fails(()=>kernel.open(directory,2049),'EISDIR') &&
        fails(()=>kernel.open(directory+'/source.txt',2048|KernelOpenFlags.O_DIRECTORY),'ENOTDIR');
      checks.unknownFlags=fails(()=>kernel.open(directory+'/source.txt',2048|KernelOpenFlags.O_ASYNC),'ENOTSUP');
      const readonly=new KernelFileSystem({mounts:[{path:'/',storage:this.storage,readOnly:true}]});
      try {checks.readonly=fails(()=>readonly.open(directory+'/source.txt',2049),'EROFS');}
      finally {readonly.dispose();}
      const metadata=kernel.open(directory+'/source.txt',KernelOpenFlags.O_PATH|2048);
      checks.pathOnly=kernel.descriptors.get(metadata).flags===0 &&
        fails(()=>kernel.read(metadata,new Uint8Array(1),null),'EBADF');
      kernel.close(metadata);
      const ok=Object.values(checks).every(Boolean);
      return Response.json({ok,calls,checks,note:'Canonical SQL filesystem and Node fs numeric opens. Official tools and shell execution are separate.'},{status:ok?200:500});
    } catch(error) {
      return Response.json({ok:false,checks,error:String(error),stack:error.stack},{status:500});
    } finally {kernel.dispose();}
  }
}
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-nonblocking-descriptor-relative-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NonblockingFilesystemFacet",
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
