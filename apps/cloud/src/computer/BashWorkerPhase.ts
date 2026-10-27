import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelBashForkSource, KernelBashForkState } from "../kernel/KernelBashFork.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import type { KernelExitStatus } from "../kernel/KernelProcessTable.ts";
import type {
  KernelBashOperation,
  KernelBashOperationResult,
  KernelBashPort,
} from "../kernel/KernelBashPort.ts";
import { createKernelBashOperations } from "../kernel/KernelBashOperations.ts";
import type { ChildWorkerExecution } from "./ChildWorkerCapacity.ts";
import { storeBashCheckpoint, type BashCheckpoint } from "./BashCheckpointStore.ts";
import type { WorkerBashPhase } from "./WorkerBashHost.ts";

type Operations = ReturnType<typeof createKernelBashOperations>;
type BashResume =
  | { readonly kind: "resume"; readonly source: KernelBashForkSource }
  | { readonly kind: "exit"; readonly status: KernelExitStatus };

export interface ParkedBashProcess {
  readonly port: KernelBashPort;
  readonly pid: number;
  readonly checkpoint: BashCheckpoint;
  resume(): Promise<BashResume>;
}

/** One physical RPC may pack several processes. None resumes until that RPC has stopped. */
export class BashWorkerPhase implements WorkerBashPhase {
  readonly #filesystem: KernelFileSystem;
  readonly #rootPid: number;
  readonly #signal: AbortSignal;
  readonly #operations = new Map<KernelBashPort, Operations>();
  readonly #parked = new Map<number, ParkedBashProcess>();
  readonly #startFork: (work: () => Promise<void>) => void;
  #stopped = false;
  #dispatchFailed = false;

  constructor(options: {
    readonly filesystem: KernelFileSystem;
    readonly rootPid: number;
    readonly signal: AbortSignal;
    readonly startFork: (work: () => Promise<void>) => void;
  }) {
    this.#filesystem = options.filesystem;
    this.#rootPid = options.rootPid;
    this.#signal = options.signal;
    this.#startFork = options.startFork;
  }

  dispatchFailed() {
    this.#dispatchFailed = true;
  }

  startOperation(port: KernelBashPort, operation: KernelBashOperation) {
    if (this.#stopped) throw new Error("Bash Worker phase has stopped");
    return this.#operationsFor(port).start(operation);
  }

  async park(
    port: KernelBashPort,
    pid: number,
    source: KernelBashForkSource,
    operationId?: string,
  ) {
    if (this.#stopped || this.#parked.has(pid)) throw new Error("Bash process already parked");
    const stateReply = await source.state();
    let continuation: KernelBashForkState["continuation"];
    try {
      continuation = structuredClone(stateReply.continuation);
    } finally {
      disposeKernelRpcReply(stateReply);
    }
    const operations = this.#operationsFor(port);
    let result: KernelBashOperationResult | undefined;
    let pending = operationId ?? continuation.operationId;
    // Growth can move a continuation before its syscall has started.
    if (
      pending === undefined &&
      continuation.result === undefined &&
      continuation.pending?.kind === "operation"
    ) {
      const started = await operations.start(continuation.pending.operation);
      if (started.kind === "ready") result = started.result;
      else pending = started.id;
    }
    const checkpoint = await storeBashCheckpoint(this.#filesystem, source, this.#signal);
    let consumed = false;
    this.#parked.set(pid, {
      port,
      pid,
      checkpoint,
      resume: async () => {
        if (!this.#stopped || consumed) throw new Error("Bash checkpoint is not ready for restore");
        consumed = true;
        try {
          const completed =
            result ?? (pending === undefined ? undefined : await operations.take(pending));
          // Successful exec replaced Bash. Restoring its old heap just to exit can deadlock a pipe.
          if (completed?.kind === "exec" && completed.value.kind === "exit") {
            return { kind: "exit", status: completed.value.status };
          }
          return {
            kind: "resume",
            source: checkpoint.source((saved) =>
              completed === undefined
                ? saved
                : {
                    ...saved,
                    continuation: { ...saved.continuation, result: completed },
                  },
            ),
          };
        } catch (error) {
          await checkpoint.close();
          throw error;
        } finally {
          await operations.close();
        }
      },
    });
  }

  async placeFork(port: KernelBashPort, _pid: number, source: KernelBashForkSource) {
    if (this.#stopped) throw new Error("Bash Worker phase has stopped");
    const checkpoint = await storeBashCheckpoint(this.#filesystem, source, this.#signal);
    this.#startFork(async () => {
      try {
        disposeKernelRpcReply(await port.runFork(checkpoint.source()));
      } finally {
        await checkpoint.close();
      }
    });
  }

  /** Called only by the dispatch stop-ACK path, before it releases the physical slot. */
  async stopped(execution: ChildWorkerExecution) {
    if (this.#stopped) throw new Error("Bash Worker phase already stopped");
    const abandoning = this.#dispatchFailed || this.#signal.aborted;
    if (this.#parked.size > 0 && !abandoning) await execution.handoff();
    this.#stopped = true;
    const retained = new Set([...this.#parked.values()].map((parked) => parked.port));
    for (const [port, operations] of this.#operations) {
      if (!retained.has(port)) await operations.close();
    }
    this.#operations.clear();
    if (this.#dispatchFailed) {
      // The dispatch cleanup closes this owner before the stop ACK reaches this phase.
      await this.#closeParked();
      return;
    }
    if (this.#signal.aborted) {
      await this.#closeParked(false);
      return;
    }
    for (const parked of this.#parked.values()) {
      if (parked.pid === this.#rootPid) continue;
      this.#startFork(async () => {
        try {
          const resumed = await parked.resume();
          if (this.#signal.aborted || this.#dispatchFailed) return;
          if (resumed.kind === "exit") {
            await parked.port.complete({ kind: "exit", status: resumed.status });
          } else {
            disposeKernelRpcReply(await parked.port.runFork(resumed.source));
          }
        } finally {
          await parked.checkpoint.close();
        }
      });
    }
  }

  async #closeParked(includeRoot = true) {
    const failures: unknown[] = [];
    await Promise.all(
      [...this.#parked.values()]
        .filter((parked) => includeRoot || parked.pid !== this.#rootPid)
        .map(async (parked) => {
          try {
            await parked.resume();
          } catch (error) {
            failures.push(error);
          }
          try {
            await parked.checkpoint.close();
          } catch (error) {
            failures.push(error);
          }
        }),
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Bash parked process cleanup failed");
  }

  get root(): ParkedBashProcess | undefined {
    return this.#parked.get(this.#rootPid);
  }

  #operationsFor(port: KernelBashPort): Operations {
    let operations = this.#operations.get(port);
    if (operations === undefined) {
      operations = createKernelBashOperations(port);
      this.#operations.set(port, operations);
    }
    return operations;
  }
}
