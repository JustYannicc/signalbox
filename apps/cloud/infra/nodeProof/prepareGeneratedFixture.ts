// @effect-diagnostics nodeBuiltinImport:off - prepares an isolated native binding proof.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Esbuild from "esbuild";

export async function prepareNodeGeneratedCodeProof(destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const entryPoint = NodeURL.fileURLToPath(
    new URL("../../src/isolate/NodeGeneratedCode.ts", import.meta.url),
  );
  const runtime = await Esbuild.build({
    entryPoints: [entryPoint],
    outfile: "runtime-generated.js",
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    packages: "external",
    write: false,
  });
  const runtimeSource = runtime.outputFiles?.[0]?.text;
  if (!runtimeSource) throw new Error("Generated-code proof runtime bundle was empty");
  await NodeFSP.writeFile(NodePath.join(destination, "runtime-generated.js"), runtimeSource);

  const valueSource = `let counter = 0;
export default {async fetch(request, env) {
  const input = await request.json();
  return Response.json({value:input.n * 7,
    counter:++counter, bindings:Object.keys(env ?? {}).sort()});
}};`;
  const changedSource = `export default {fetch() {
  return new Response('native-changed-source', {status:418,headers:{'x-node-proof':'changed'}});
}};`;
  const failedSource = `export default {fetch() {throw new Error('node-native-proof-failure');}};`;
  const main = `import {DurableObject} from 'cloudflare:workers';
import {createNodeGeneratedCode} from './runtime-generated.js';
const valueSource = ${JSON.stringify(valueSource)};
const changedSource = ${JSON.stringify(changedSource)};
const failedSource = ${JSON.stringify(failedSource)};
export class NodeGeneratedCodeFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.calls = 0;
    this.storage = ctx.storage;
    this.generated = createNodeGeneratedCode({storage:ctx.storage,
      scopeId:'node-native-async-proof',fetcher:env.CODE_GENERATION});
  }
  async fetch() {
    try {
      const call = ++this.calls;
      const input = {id:'node-native-async',mainModule:'main.js',
        modules:{'main.js':valueSource},input:{n:6}};
      const firstResponse = await this.generated.invoke(input);
      if (!firstResponse.ok) throw new Error('first native response: ' + firstResponse.status);
      const first = await firstResponse.json();
      const secondResponse = await this.generated.invoke({...input,input:{n:7}});
      if (!secondResponse.ok) throw new Error('second native response: ' + secondResponse.status);
      const second = await secondResponse.json();
      const changed = await this.generated.invoke({...input,modules:{'main.js':changedSource}});
      const changedBody = await changed.text();
      const failed = await this.generated.invoke({...input,modules:{'main.js':failedSource}});
      await failed.text();
      let unavailable;
      try {
        await createNodeGeneratedCode({storage:this.storage,scopeId:'without-binding'}).invoke(input);
      } catch (error) { unavailable = error.code; }
      let invalid;
      let invalidFetchCalls = 0;
      try {
        await createNodeGeneratedCode({storage:this.storage,scopeId:'invalid-input',
          fetcher:{fetch(){invalidFetchCalls++;throw new Error('must not fetch');}}})
          .invoke({...input,mainModule:'missing.js'});
      } catch (error) { invalid = error.code; }
      const checks = {
        generatedValue:first.value === 42 && second.value === 49,
        sameSourceIdentity:first.counter === call * 2 - 1 && second.counter === call * 2,
        noInheritedBindings:first.bindings.length === 0 && second.bindings.length === 0,
        changedSource:changed.status === 418 && changed.headers.get('x-node-proof') === 'changed' &&
          changedBody === 'native-changed-source',
        nativeFailure:failed.status === 500,
        missingBinding:unavailable === 'ERR_NODE_GENERATED_CODE_UNAVAILABLE',
        validationBeforeFetch:invalid === 'ERR_NODE_GENERATED_CODE_INVALID_INPUT' && invalidFetchCalls === 0,
      };
      const ok = Object.values(checks).every(value => value === true);
      return Response.json({ok,call,checks,counters:[first.counter,second.counter]}, {status:ok ? 200 : 500});
    } catch(error) {return Response.json({ok:false,error:String(error)}, {status:500});}
  }
}`;
  await NodeFSP.writeFile(NodePath.join(destination, "main.js"), main);
  await NodeFSP.writeFile(
    NodePath.join(destination, "manifest.json"),
    JSON.stringify(
      {
        id: "node-generated-code-async-v1",
        mode: "facet",
        mainModule: "main.js",
        entrypoint: "NodeGeneratedCodeFacet",
        allowGeneratedCode: true,
        modules: {
          "main.js": { path: "main.js", type: "js" },
          "runtime-generated.js": { path: "runtime-generated.js", type: "js" },
        },
        paths: ["/status", "/again"],
      },
      null,
      2,
    ),
  );
}
