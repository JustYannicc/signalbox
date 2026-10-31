// @effect-diagnostics nodeBuiltinImport:off - Resolve the Cloudflare Worker class in this isolated test realm.
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";

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
  throw new Error("Fresh Claude handoff regression needs an isolated Node realm.");
const port = NodeWorkerThreads.parentPort;
try {
  const { freshClaudeNativeHandoff } = await import("./freshClaudeNativeHandoff.fixture.ts");
  const exit = await Effect.runPromiseExit(freshClaudeNativeHandoff());
  if (Exit.isFailure(exit)) port.postMessage({ ok: false, error: Cause.pretty(exit.cause) });
  else port.postMessage({ ok: true, report: exit.value });
} catch (error) {
  port.postMessage({ ok: false, error: NodeUtil.inspect(error, { depth: 20 }) });
}
port.close();
