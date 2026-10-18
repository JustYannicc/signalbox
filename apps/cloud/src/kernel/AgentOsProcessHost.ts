import {
  decodeAgentOsSpawnRequest,
  writeAgentOsPid,
  type AgentOsProcessWireLimits,
  type AgentOsSpawnRequest,
} from "./AgentOsProcessWire.ts";
import { kernelError, type KernelHandle, type KernelResult } from "./KernelAbi.ts";
import { runCurrentKernelCpuAsyncSystemImport } from "./KernelCpuExecution.ts";
import type { KernelProcessTable } from "./KernelProcessTable.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

const EFAULT = 21;
const EINVAL = 28;
const EAGAIN = 6;
const ENOTSUP = 58;
const ESRCH = 71;

interface ProcessHostOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly parent?: KernelHandle<"process">;
  readonly signal?: AbortSignal;
  readonly limits?: AgentOsProcessWireLimits;
  /** Owns prepared descriptors through dispatch failure or the child's final exit. */
  readonly spawn: (request: AgentOsSpawnRequest) => Promise<KernelResult<KernelHandle<"process">>>;
}

const kernelErrno = (code: string) => {
  switch (code) {
    case "INVALID_ARGUMENT":
      return 28;
    case "NOT_FOUND":
      return 44;
    case "PERMISSION_DENIED":
      return 63;
    case "RESOURCE_LIMIT":
      return 6;
    case "CANCELLED":
      return 11;
    case "EXPIRED":
      return 73;
    case "INVALID_HANDLE":
      return 71;
    case "UNSUPPORTED":
      return 58;
    default:
      return 29;
  }
};

/** AgentOS process imports. JSPI wrapping belongs at the direct Wasm import boundary. */
export class AgentOsProcessHost {
  readonly #options: ProcessHostOptions;
  readonly suspendingImports = Object.freeze(["proc_spawn_v3", "proc_waitpid_v2"]);
  readonly imports = {
    proc_spawn_v3: (...args: number[]) => this.#spawn(args),
    proc_waitpid_v2: (
      pid: number,
      options: number,
      exitCode: number,
      signal: number,
      waitedPid: number,
      coreDumped: number,
    ) => this.#waitpid(pid, options, [exitCode, signal, waitedPid, coreDumped]),
    proc_signal_mask_v2: (
      how: number,
      setLow: number,
      setHigh: number,
      oldLow: number,
      oldHigh: number,
    ) => this.#signalMask(how, setLow, setHigh, oldLow, oldHigh),
    proc_kill: (pid: number, signal: number) => this.#kill(pid, signal),
    proc_getpid: (output: number) => this.#identity(output, "pid"),
    proc_getppid: (output: number) => this.#identity(output, "parentPid"),
  };

  constructor(options: ProcessHostOptions) {
    this.#options = options;
  }

  getImportObject(): { host_process: Record<string, unknown> } {
    const wasm = WebAssembly as unknown as {
      Suspending: new (fn: (...args: number[]) => Promise<number>) => unknown;
    };
    if (typeof wasm.Suspending !== "function")
      throw new Error("Process imports require WebAssembly JSPI");
    return {
      host_process: {
        ...this.imports,
        proc_spawn_v3: new wasm.Suspending(this.imports.proc_spawn_v3),
        proc_waitpid_v2: new wasm.Suspending(this.imports.proc_waitpid_v2),
      },
    };
  }

  #spawn(args: readonly number[]): Promise<number> {
    // Spawn admission can await preparation without going through a wake token.
    return runCurrentKernelCpuAsyncSystemImport(async (runSystem) => {
      if (this.#options.signal?.aborted) return 11;
      const decoded = decodeAgentOsSpawnRequest(this.#options.memory(), args, this.#options.limits);
      if (decoded.status !== "ok") return decoded.errno;
      const result = await this.#options.spawn(decoded.value);
      return runSystem(() => {
        if (result.status === "would_block") {
          this.#options.wakes.release(result.wakeToken);
          // The prepared spawn owner must await admission itself; repeating spawn
          // here could launch a second child or repeat its file actions.
          return 29;
        }
        if (result.status !== "ok") return kernelErrno(result.error.code);
        const child = this.#options.processes.info(result.value);
        if (child.status === "would_block") {
          this.#options.wakes.release(child.wakeToken);
          return EAGAIN;
        }
        if (child.status === "error") return kernelErrno(child.error.code);
        return writeAgentOsPid(this.#options.memory(), decoded.value.pidPointer, child.value.pid);
      });
    });
  }

  async #waitpid(pid: number, options: number, pointers: readonly number[]): Promise<number> {
    if (!this.#validOutputs(pointers)) return 21;
    const result = await this.#wait(() =>
      this.#options.processes.waitpid(this.#options.parent, pid | 0, options >>> 0),
    );
    if (result.status === "error") {
      return result.error.code === "NOT_FOUND" ? 12 : kernelErrno(result.error.code);
    }
    const value = result.value;
    const status = "status" in value ? value.status : undefined;
    const values = [
      status?.exitCode ?? 0,
      status?.signal ?? 0,
      value.pid,
      status?.coreDumped ? 1 : 0,
    ];
    // JSPI may have allowed memory.grow while the host awaited readiness.
    const memory = this.#options.memory();
    for (let index = 0; index < pointers.length; index++) {
      const error = writeAgentOsPid(memory, pointers[index]!, values[index]! >>> 0);
      if (error !== 0) return error;
    }
    return 0;
  }

  #identity(pointer: number, field: "pid" | "parentPid") {
    if (!this.#validOutputs([pointer])) return EFAULT;
    const result = this.#options.processes.info(this.#options.parent);
    if (result.status === "would_block") {
      this.#options.wakes.release(result.wakeToken);
      return EAGAIN;
    }
    if (result.status === "error") return kernelErrno(result.error.code);
    return writeAgentOsPid(this.#options.memory(), pointer, result.value[field]);
  }

  #validOutputs(pointers: readonly number[]) {
    const length = this.#options.memory().buffer.byteLength;
    return pointers.every((pointer) => (pointer >>> 0) + 4 <= length);
  }

  #signalMask(how: number, _setLow: number, _setHigh: number, oldLow: number, oldHigh: number) {
    if (!this.#validOutputs([oldLow, oldHigh])) return EFAULT;
    if (how >>> 0 > 3) return EINVAL;
    // The process table does not own blocked/pending signals yet. Returning
    // success with an empty mask would lie about later signal delivery.
    return ENOTSUP;
  }

  #kill(pid: number, signal: number) {
    const targetPid = pid >>> 0;
    // This import takes a positive u32 PID. Zero and negative values are not
    // process-group selectors here, even though the table also serves waitpid.
    if (targetPid === 0) return ESRCH;
    const result = this.#options.processes.signalPid(this.#options.parent, targetPid, signal >>> 0);
    if (result.status === "ok") return 0;
    if (result.status === "would_block") {
      this.#options.wakes.release(result.wakeToken);
      return EAGAIN;
    }
    if (result.error.code === "NOT_FOUND") return ESRCH;
    return kernelErrno(result.error.code);
  }

  async #wait<T>(attempt: () => KernelResult<T>) {
    for (;;) {
      if (this.#options.signal?.aborted) return kernelError("CANCELLED", "Process wait cancelled");
      const result = attempt();
      if (result.status !== "would_block") return result;
      const token = result.wakeToken;
      try {
        const ready = await this.#options.wakes.wait(token, this.#options.signal);
        if (ready.status !== "ok") return ready;
      } finally {
        this.#options.wakes.release(token);
      }
    }
  }
}
