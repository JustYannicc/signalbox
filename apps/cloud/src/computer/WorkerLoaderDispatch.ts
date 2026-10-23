import { RpcTarget } from "cloudflare:workers";
import { childWorkerId, childWorkerInstanceId } from "./ChildWorkerIdentity.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import {
  CHILD_WORKER_KILLED_BY_SIGKILL,
  childWorkerStubFor,
  discardChildWorkerStub,
  isChildWorkerMemoryLimitFailure,
} from "./ChildWorkerLoaderRecovery.ts";
import { resolveChildWorkerLimits, type ResolvedChildWorkerLimits } from "./ChildWorkerLimits.ts";
import type { ChildWorkerDispatch, ChildWorkerInvocation } from "./ChildWorkerProgram.ts";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";

interface ChildEntrypoint<Host extends object> {
  run(command: KernelCommand, invocation: ChildInvocation<Host>): Promise<KernelCommandExit>;
}

/** Transports prepared child code without moving its completion acknowledgement out of the facet. */
export interface ChildWorkerLoaderPort {
  readonly run: (input: ChildWorkerInvocation, invocation: RpcTarget) => Promise<KernelCommandExit>;
}

class ChildInvocation<Host extends object> extends RpcTarget {
  readonly #host: Host;
  readonly #acknowledge: () => void;

  constructor(host: Host, acknowledge: () => void) {
    super();
    this.#host = host;
    this.#acknowledge = acknowledge;
  }

  host() {
    return this.#host;
  }

  stopped() {
    this.#acknowledge();
  }
}

function dispatchModules(input: ChildWorkerInvocation, limits: ResolvedChildWorkerLimits) {
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

/** Code and syscalls are supplied by Computer; guest programs receive no outbound network binding. */
export function createWorkerLoaderDispatch<Host extends object>(
  loader: WorkerLoader | ChildWorkerLoaderPort,
): ChildWorkerDispatch<Host> {
  return {
    async run(input: ChildWorkerInvocation, host: Host) {
      const limits = resolveChildWorkerLimits(input.limits);
      const stopped = Promise.withResolvers<void>();
      let acknowledged = false;
      const invocation = new ChildInvocation(host, () => {
        acknowledged = true;
        stopped.resolve();
      });
      let submitted = false;
      let invokingChild = false;
      let failedWorker:
        | { readonly id: string; readonly freshIsolate: boolean | undefined }
        | undefined;
      try {
        const code = dispatchModules(input, limits);
        let exit: KernelCommandExit;
        if ("run" in loader) {
          for (const module of Object.values(code.modules)) {
            if (
              typeof module !== "string" &&
              "wasm" in module &&
              module.wasm instanceof WebAssembly.Module
            ) {
              throw new Error("Compiled child WASM must stay in the loader-owned registry");
            }
          }
          submitted = true;
          invokingChild = true;
          exit = await loader.run(
            {
              ...code,
              command: input.command,
              ...(input.freshIsolate === undefined ? {} : { freshIsolate: input.freshIsolate }),
            },
            invocation,
          );
        } else {
          for (const module of Object.values(code.modules)) {
            if (typeof module !== "string" && "wasmReference" in module) {
              throw new Error("Child WASM reference requires a compiled module registry");
            }
          }
          const workerCode = {
            compatibilityDate: "2026-10-19",
            compatibilityFlags: ["nodejs_compat"],
            ...code,
            globalOutbound: null,
          };
          const workerId = childWorkerInstanceId(
            await childWorkerId(workerCode, input.entrypoint),
            input.freshIsolate,
          );
          failedWorker = { id: workerId, freshIsolate: input.freshIsolate };
          submitted = true;
          // Native Worker Loader supports compiled WASM inputs; installed types still require bytes.
          const worker = childWorkerStubFor(loader, workerId, workerCode as WorkerLoaderWorkerCode);
          const entrypoint = worker.getEntrypoint(undefined, {
            limits,
          }) as unknown as ChildEntrypoint<Host>;
          invokingChild = true;
          exit = await entrypoint.run(input.command, invocation);
        }
        await stopped.promise;
        return exit;
      } catch (cause) {
        if (invokingChild && isChildWorkerMemoryLimitFailure(cause)) {
          if (failedWorker !== undefined) {
            discardChildWorkerStub(
              loader as WorkerLoader,
              failedWorker.id,
              failedWorker.freshIsolate,
            );
          }
          invocation.stopped();
          return CHILD_WORKER_KILLED_BY_SIGKILL;
        }
        if (!submitted) invocation.stopped();
        // RPC failure and host capability closure cannot prove that the child stopped.
        throw new ChildWorkerDispatchError(
          cause,
          acknowledged ? { kind: "stopped" } : { kind: "unconfirmed", stopped: stopped.promise },
        );
      }
    },
  };
}
