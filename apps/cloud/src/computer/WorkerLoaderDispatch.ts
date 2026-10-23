import { RpcTarget } from "cloudflare:workers";
import { createChildWorkerDispatchCode } from "./ChildWorkerDispatchCode.ts";
export { childWorkerDispatchCodeId } from "./ChildWorkerDispatchCode.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import {
  acknowledgeChildWorkerMemoryLoss,
  CHILD_WORKER_KILLED_BY_SIGKILL,
  isChildWorkerMemoryLimitFailure,
  requireChildWorkerLoaderId,
} from "./ChildWorkerLoaderRecovery.ts";
import { resolveChildWorkerLimits } from "./ChildWorkerLimits.ts";
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
  readonly #onMemoryLost: (() => Promise<void>) | undefined;
  #memoryLoss: Promise<void> | undefined;

  constructor(host: Host, acknowledge: () => void, onMemoryLost?: () => Promise<void>) {
    super();
    this.#host = host;
    this.#acknowledge = acknowledge;
    this.#onMemoryLost = onMemoryLost;
  }

  host() {
    return this.#host;
  }

  stopped() {
    this.#acknowledge();
  }

  lost(): Promise<void> {
    if (this.#memoryLoss === undefined) {
      const onMemoryLost = this.#onMemoryLost;
      this.#memoryLoss =
        onMemoryLost === undefined
          ? Promise.reject(new Error("Child memory loss requires an onMemoryLost callback"))
          : Promise.resolve().then(onMemoryLost);
    }
    return this.#memoryLoss;
  }
}

/** Code and syscalls are supplied by Computer; guest programs receive no outbound network binding. */
export function createWorkerLoaderDispatch<Host extends object>(
  loader: WorkerLoader | ChildWorkerLoaderPort,
): ChildWorkerDispatch<Host> {
  return {
    async run(input: ChildWorkerInvocation, host: Host, onMemoryLost?: () => Promise<void>) {
      const limits = resolveChildWorkerLimits(input.limits);
      const stopped = Promise.withResolvers<void>();
      let acknowledged = false;
      const invocation = new ChildInvocation(
        host,
        () => {
          acknowledged = true;
          stopped.resolve();
        },
        onMemoryLost,
      );
      let submitted = false;
      let invokingChild = false;
      try {
        const loaderId = requireChildWorkerLoaderId(input);
        const workerCode = createChildWorkerDispatchCode(input, limits);
        const code = {
          mainModule: workerCode.mainModule,
          modules: workerCode.modules,
          limits: workerCode.limits,
        };
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
          const childInput: ChildWorkerInvocation = {
            ...code,
            loaderId,
            command: input.command,
          };
          exit = await loader.run(childInput, invocation);
        } else {
          for (const module of Object.values(code.modules)) {
            if (typeof module !== "string" && "wasmReference" in module) {
              throw new Error("Child WASM reference requires a compiled module registry");
            }
          }
          submitted = true;
          // Native Worker Loader supports compiled WASM inputs; installed types still require bytes.
          const worker = loader.get(loaderId, () => workerCode as WorkerLoaderWorkerCode);
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
          try {
            await acknowledgeChildWorkerMemoryLoss(invocation);
          } catch (retirementFailure) {
            throw new ChildWorkerDispatchError(retirementFailure, {
              kind: "unconfirmed",
              stopped: stopped.promise,
            });
          }
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
