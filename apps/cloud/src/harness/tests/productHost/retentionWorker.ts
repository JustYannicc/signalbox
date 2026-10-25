import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";

NodeModule.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "data:text/javascript,export class RpcTarget {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { runRetentionProbe } = await import("./retention.ts");
NodeProcess.stdout.write(
  `${JSON.stringify({ pid: NodeProcess.pid, results: await runRetentionProbe() })}\n`,
);
