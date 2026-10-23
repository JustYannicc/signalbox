import { childWorkerId } from "./ChildWorkerIdentity.ts";
import { resolveChildWorkerLimits, type ResolvedChildWorkerLimits } from "./ChildWorkerLimits.ts";
import type { ChildWorkerInvocation } from "./ChildWorkerCode.ts";

function dispatchModules(
  input: Omit<ChildWorkerInvocation, "loaderId">,
  limits: ResolvedChildWorkerLimits,
) {
  let wrapper = "__signalbox_child_dispatch.js";
  const paths = new Set(
    Object.keys(input.modules).map((name) => new URL(name, "https://child.invalid/").pathname),
  );
  while (paths.has(`/${wrapper}`)) wrapper = `_${wrapper}`;
  return {
    mainModule: wrapper,
    modules: {
      ...input.modules,
      [wrapper]: `import {WorkerEntrypoint} from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(command, invocation) {
    try {
      using host = await invocation.host();
      const module = await import(${JSON.stringify(`./${input.mainModule}`)});
      const User = module[${JSON.stringify(input.entrypoint ?? "default")}];
      const user = new User(this.ctx, this.env);
      return await user.run(command, host);
    } finally {
      await invocation.stopped();
    }
  }
}
`,
    },
    limits,
  };
}

export function createChildWorkerDispatchCode(
  input: Omit<ChildWorkerInvocation, "loaderId">,
  limits: ResolvedChildWorkerLimits,
) {
  return {
    compatibilityDate: "2026-10-19",
    compatibilityFlags: ["nodejs_compat"],
    ...dispatchModules(input, limits),
    globalOutbound: null,
  };
}

/** The admission code ID describes wrapped modules and normalized Worker Loader policy. */
export async function childWorkerDispatchCodeId(
  input: Omit<ChildWorkerInvocation, "loaderId">,
): Promise<string> {
  const limits = resolveChildWorkerLimits(input.limits);
  return childWorkerId(createChildWorkerDispatchCode(input, limits));
}
