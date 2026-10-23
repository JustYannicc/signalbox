import { RpcTarget } from "cloudflare:workers";
import { createChildWorkerDispatchCode } from "./ChildWorkerDispatchCode.ts";
export { childWorkerDispatchCodeId } from "./ChildWorkerDispatchCode.ts";
import {
  ChildWorkerDispatchError,
  WORKER_LOADER_QUOTA_MESSAGES,
} from "./ChildWorkerDispatchError.ts";
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

const enteredChildInvocations = new WeakSet<object>();
const stoppedChildInvocations = new WeakSet<object>();

/** Only these runtime quota errors prove that no dynamic child invocation was created. */
export function workerLoaderQuotaFailure(cause: unknown): (Error & { code: "EAGAIN" }) | undefined {
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null) return;
  const name = Reflect.get(cause, "name");
  const message = Reflect.get(cause, "message");
  if (
    name !== "Error" ||
    typeof message !== "string" ||
    !WORKER_LOADER_QUOTA_MESSAGES.includes(message)
  )
    return;
  if (Reflect.get(cause, "code") === "EAGAIN") return cause as Error & { code: "EAGAIN" };
  return Object.assign(new Error(message, { cause }), { code: "EAGAIN" as const });
}

/** The dispatch wrapper calls host before loading or running guest code. */
export function hasChildWorkerInvocationEntered(invocation: unknown): boolean {
  if ((typeof invocation !== "object" || invocation === null) && typeof invocation !== "function")
    return false;
  return enteredChildInvocations.has(invocation);
}

/** The generated wrapper stops in finally after a guest failure; this marker cannot come from guest data. */
export function hasChildWorkerInvocationStopped(invocation: unknown): boolean {
  if ((typeof invocation !== "object" || invocation === null) && typeof invocation !== "function")
    return false;
  return stoppedChildInvocations.has(invocation);
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
    enteredChildInvocations.add(this);
    return this.#host;
  }

  stopped() {
    stoppedChildInvocations.add(this);
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
          let entrypoint: ChildEntrypoint<Host> | undefined;
          try {
            entrypoint = worker.getEntrypoint(undefined, {
              limits,
            }) as unknown as ChildEntrypoint<Host>;
            exit = await entrypoint.run(input.command, invocation);
          } finally {
            disposeWorkerLoaderStubs(entrypoint, worker);
          }
        }
        await stopped.promise;
        return exit;
      } catch (cause) {
        if (
          !hasChildWorkerInvocationStopped(invocation) &&
          isChildWorkerMemoryLimitFailure(cause)
        ) {
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
        let failureCause = cause;
        const quotaFailure = workerLoaderQuotaFailure(cause);
        if (quotaFailure !== undefined && !hasChildWorkerInvocationEntered(invocation)) {
          if (!acknowledged) invocation.stopped();
          failureCause = quotaFailure;
        }
        if (!submitted && !acknowledged) invocation.stopped();
        // RPC failure and host capability closure cannot prove that the child stopped.
        throw new ChildWorkerDispatchError(
          failureCause,
          acknowledged ? { kind: "stopped" } : { kind: "unconfirmed", stopped: stopped.promise },
        );
      }
    },
  };
}

/** Worker Loader results are RPC stubs; release both even if one disposer fails. */
export function disposeWorkerLoaderStubs(...stubs: readonly unknown[]): void {
  const failures: unknown[] = [];
  for (const stub of stubs) {
    if ((typeof stub !== "object" && typeof stub !== "function") || stub === null) continue;
    const dispose = Reflect.get(stub, Symbol.dispose);
    if (typeof dispose !== "function") continue;
    try {
      dispose.call(stub);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Worker Loader stubs failed to dispose");
  }
}
