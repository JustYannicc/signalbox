// @effect-diagnostics nodeBuiltinImport:off - Controlled native modules need their own Node global state.
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeUtil from "node:util";
NodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class RpcTarget {};export class WorkerEntrypoint {};export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const port = NodeWorkerThreads.parentPort;
if (port === null) throw new Error("Split product fixture needs its isolated Node realm");
try {
  const { run } = await import("./splitScenario.ts");
  await run(NodeWorkerThreads.workerData);
  port.postMessage({ ok: true });
} catch (error) {
  port.postMessage({ ok: false, error: NodeUtil.inspect(error, { depth: 20 }) });
}
port.close();
