import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeUtil from "node:util";

NodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "data:text/javascript,export class RpcTarget {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const port = NodeWorkerThreads.parentPort;
if (port === null) throw new Error("Continuation fixture needs its isolated Node realm");
try {
  const { run } = await import("./continuationScenario.ts");
  await run();
  port.postMessage({ ok: true });
} catch (error) {
  port.postMessage({ ok: false, error: NodeUtil.inspect(error, { depth: 15 }) });
}
port.close();
