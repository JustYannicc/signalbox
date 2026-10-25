import * as NodeAssert from "node:assert/strict";
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
if (NodeWorkerThreads.parentPort === null)
  throw new Error("Product fixture needs its isolated Node realm");
const port = NodeWorkerThreads.parentPort;
const hostProcess = globalThis.process;
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => unhandled.push(error);
hostProcess.on("unhandledRejection", onUnhandled);
try {
  const { run } = await import("./exitOutputScenario.ts");
  await run();
  NodeAssert.deepEqual(unhandled, []);
  port.postMessage({ ok: true });
} catch (error) {
  port.postMessage({ ok: false, error: NodeUtil.inspect(error, { depth: 12 }) });
} finally {
  hostProcess.removeListener("unhandledRejection", onUnhandled);
}
port.close();
