import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";
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

export interface ParkedBashProcess {
  readonly port: KernelBashPort;
  readonly pid: number;
  readonly checkpoint: BashCheckpoint;
  resume(): Promise<KernelBashForkSource>;
}

/** One physical RPC may pack several processes. None resumes until that RPC has stopped. */
export class BashWorkerPhase implements WorkerBashPhase {
  readonly #filesystem: KernelFileSystem;
  readonly #rootPid: number;
  readonly #operations = new Map<KernelBashPort, Operations>();
  readonly #parked = new Map<number, ParkedBashProcess>();
  readonly #startFork: (work: () => Promise<void>) => void;
  #stopped = false;

  constructor(options: {
    readonly filesystem: KernelFileSystem;
    readonly rootPid: number;
    readonly startFork: (work: () => Promise<void>) => void;
  }) {
    this.#filesystem = options.filesystem;
    this.#rootPid = options.rootPid;
    this.#startFork = options.startFork;
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
    const state = await source.state();
    const operations = this.#operationsFor(port);
    let result: KernelBashOperationResult | undefined;
    let pending = operationId ?? state.continuation.operationId;
    // Growth can move a continuation before its syscall has started.
    if (
      pending === undefined &&
      state.continuation.result === undefined &&
      state.continuation.pending?.kind === "operation"
    ) {
      const started = await operations.start(state.continuation.pending.operation);
      if (started.kind === "ready") result = started.result;
      else pending = started.id;
    }
    const checkpoint = await storeBashCheckpoint(this.#filesystem, source);
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
          return checkpoint.source((saved) =>
            completed === undefined
              ? saved
              : {
                  ...saved,
                  continuation: { ...saved.continuation, result: completed },
                },
          );
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
    const checkpoint = await storeBashCheckpoint(this.#filesystem, source);
    this.#startFork(async () => {
      try {
        await port.runFork(checkpoint.source());
      } finally {
        await checkpoint.close();
      }
    });
  }

  /** Called only by the dispatch stop-ACK path, before it releases the physical slot. */
  async stopped(execution: ChildWorkerExecution) {
    if (this.#stopped) throw new Error("Bash Worker phase already stopped");
    if (this.#parked.size > 0) await execution.handoff();
    this.#stopped = true;
    const retained = new Set([...this.#parked.values()].map((parked) => parked.port));
    for (const [port, operations] of this.#operations) {
      if (!retained.has(port)) await operations.close();
    }
    this.#operations.clear();
    for (const parked of this.#parked.values()) {
      if (parked.pid === this.#rootPid) continue;
      this.#startFork(async () => {
        try {
          await parked.port.runFork(await parked.resume());
        } finally {
          await parked.checkpoint.close();
        }
      });
    }
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
