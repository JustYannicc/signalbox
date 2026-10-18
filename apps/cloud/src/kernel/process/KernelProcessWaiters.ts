import { attemptKernelOperation, kernelError, kernelOk, type KernelResult } from "../KernelAbi.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";

export interface KernelExitStatus {
  readonly exitCode: number;
  readonly signal: number;
  readonly coreDumped: boolean;
}

export type KernelWaitOutcome =
  | { readonly kind: "exited"; readonly status: KernelExitStatus }
  | { readonly kind: "failed"; readonly error: unknown };

export interface KernelWaitableProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly outcome: KernelWaitOutcome | undefined;
}

export type KernelWaitPidResult =
  | { readonly pid: 0 }
  | { readonly pid: number; readonly status: KernelExitStatus };

export const KERNEL_WNOHANG = 1;

/** Resolves waitpid selectors and wakes blocked calls when a child changes state. */
export class KernelProcessWaiters {
  readonly #wakes: KernelWakeRegistry;
  readonly #listeners = new Set<() => void>();

  constructor(wakes: KernelWakeRegistry) {
    this.#wakes = wakes;
  }

  notify() {
    for (const wake of Array.from(this.#listeners)) wake();
  }

  waitpid<T extends KernelWaitableProcess>(
    parentPid: number,
    parentGroupId: number,
    selector: number,
    options: number,
    processes: Iterable<T>,
    isClosed: () => boolean,
    reap: (process: T) => void,
  ): KernelResult<KernelWaitPidResult> {
    return attemptKernelOperation<KernelWaitPidResult>(
      this.#wakes,
      (wake) => {
        this.#listeners.add(wake);
        return () => this.#listeners.delete(wake);
      },
      () => {
        if (isClosed()) return kernelError("CANCELLED", "Process table is closed");
        const children = [...processes]
          .filter((process) => process.parentPid === parentPid)
          .filter((process) => this.matchesSelector(process, parentGroupId, selector))
          .sort((left, right) => left.pid - right.pid);
        if (children.length === 0) {
          return kernelError("NOT_FOUND", "ECHILD: no matching child process");
        }
        const completed = children.find((process) => process.outcome !== undefined);
        if (completed) {
          const outcome = completed.outcome;
          reap(completed);
          return outcome?.kind === "exited"
            ? kernelOk({ pid: completed.pid, status: outcome.status })
            : kernelError("IO_ERROR", "Child process completion failed");
        }
        return options & KERNEL_WNOHANG ? kernelOk({ pid: 0 }) : { status: "would_block" };
      },
    );
  }

  matchesSelector(process: KernelWaitableProcess, parentGroupId: number, selector: number) {
    if (selector === -1) return true;
    if (selector === 0) return process.processGroupId === parentGroupId;
    if (selector < -1) return process.processGroupId === -selector;
    return process.pid === selector;
  }
}
