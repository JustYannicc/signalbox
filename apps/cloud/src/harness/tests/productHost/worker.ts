import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeUtil from "node:util";

NodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class RpcTarget {}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
if (NodeWorkerThreads.parentPort === null)
  throw new Error("Product fixture needs its isolated Node realm");
const port = NodeWorkerThreads.parentPort;
try {
  const { run } = await import("./scenario.ts");
  if (
    NodeWorkerThreads.workerData !== "turn" &&
    NodeWorkerThreads.workerData !== "interrupt" &&
    NodeWorkerThreads.workerData !== "dispose" &&
    NodeWorkerThreads.workerData !== "hydrate" &&
    NodeWorkerThreads.workerData !== "shutdown-omission"
  )
    throw new Error("Unknown product scenario");
  await run(
    NodeWorkerThreads.workerData === "shutdown-omission" ? "turn" : NodeWorkerThreads.workerData,
    NodeWorkerThreads.workerData === "shutdown-omission",
  );
  port.postMessage({ ok: true });
} catch (error) {
  port.postMessage({ ok: false, error: NodeUtil.inspect(error, { depth: 15 }) });
}
port.close();
