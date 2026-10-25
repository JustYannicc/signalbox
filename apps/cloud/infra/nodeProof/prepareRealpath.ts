// @effect-diagnostics nodeBuiltinImport:off - Builds proof modules without running a native probe.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

/** The coordinator runs the frozen output in local and deployed Durable Objects. */
export async function prepareNodeRealpathProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const runtime = await Esbuild.build({
    stdin: {
      sourcefile: "realpath-runtime.ts",
      resolveDir: NodeURL.fileURLToPath(new URL("../../src/", import.meta.url)),
      contents: `export {createFacetSqliteStorage} from './kernel/FacetSqliteStorage.ts';
export {KernelFileSystem} from './kernel/KernelFileSystem.ts';
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
  if (!runtimeSource) throw new Error("Realpath proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime.js"), runtimeSource);
  await NodeFSP.writeFile(
    NodePath.join(destination, "main.js"),
    `import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import {createFacetSqliteStorage,KernelFileSystem,createNodeFs} from './runtime.js';

export class NodeRealpathFacet extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS node_realpath_calls(n INTEGER)');
    const storage = createFacetSqliteStorage(ctx.storage, () => 1800000000000000000n);
    this.filesystem = new KernelFileSystem({mounts:[{path:'/',storage}],cwd:'/'});
    this.fs = createNodeFs(this.filesystem).fs;
    this.serial = Promise.resolve();
  }
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if(pathname !== '/status' && pathname !== '/again') {
      return Response.json({ok:false,checks:{route:false}},{status:404});
    }
    const response = this.serial.then(() => this.check());
    this.serial = response.catch(() => {});
    return response;
  }
  async check() {
    const checks = {};
    const {fs,filesystem} = this;
    this.ctx.storage.sql.exec('INSERT INTO node_realpath_calls VALUES(1)');
    const calls = this.ctx.storage.sql.exec('SELECT count(*) AS n FROM node_realpath_calls').one().n;
    const root = '/realpath-' + calls;
    try {
      fs.mkdirSync(root + '/target',{recursive:true});
      fs.symlinkSync('target',root + '/link');
      filesystem.chdir(root);

      let inCall = true;
      let callbackCalls = 0;
      const callbackValue = await new Promise((resolve,reject) => {
        fs.realpath.native('link',(error,value) => {
          callbackCalls++;
          if(error) reject(error);
          else resolve({value,async:!inCall});
        });
        inCall = false;
      });
      checks.nativeCallback = callbackValue.value === root + '/target' && callbackValue.async && callbackCalls === 1;

      const promisedRealpath = promisify(fs.realpath.native);
      checks.promisify = await promisedRealpath('link') === root + '/target';
      const encodedPath = await promisedRealpath('link',{encoding:'buffer'});
      checks.bufferEncoding = Buffer.isBuffer(encodedPath) && encodedPath.equals(Buffer.from(root + '/target'));

      const callbackError = await new Promise(resolve =>
        fs.realpath.native('missing',(error) => resolve(error)));
      checks.callbackError = callbackError?.code === 'ENOENT' && callbackError.path === 'missing' &&
        callbackError.syscall === 'realpath';
      let promiseError;
      try {await promisedRealpath('missing');} catch(error) {promiseError=error;}
      checks.promiseRejects = promiseError?.code === 'ENOENT' && promiseError.path === 'missing' &&
        promiseError.syscall === 'realpath';

      const regularCallback = await new Promise((resolve,reject) =>
        fs.realpath('link',(error,value) => error ? reject(error) : resolve(value)));
      checks.regularCallback = regularCallback === root + '/target';
      const ok = Object.values(checks).every(Boolean);
      return Response.json({ok,calls,checks,note:'Node fs realpath.native capability on the canonical kernel filesystem only; no official module or full runtime boot claim.'},{status:ok?200:500});
    } catch(error) {
      return Response.json({ok:false,calls,checks,error:String(error),stack:error.stack,
        note:'Node fs realpath.native capability on the canonical kernel filesystem only; no official module or full runtime boot claim.'},{status:500});
    }
  }
}
`,
  );
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-realpath-native-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeRealpathFacet",
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
