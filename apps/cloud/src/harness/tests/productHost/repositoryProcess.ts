import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";

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

const scenario = NodeProcess.argv[2];
if (
  scenario !== "repository-readiness" &&
  scenario !== "repository-failure" &&
  scenario !== "repository-cancel"
)
  throw new Error("Unknown ProductHost repository scenario");

const { run } = await import("./scenario.ts");
await run(scenario);
NodeProcess.stdout.write(JSON.stringify({ ok: true }));
