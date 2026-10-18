import { kernelError, type KernelHandle, type KernelResult } from "../KernelAbi.ts";
import type { AgentOsSpawnRequest } from "../AgentOsProcessWire.ts";
import { AgentOsDescriptorHost } from "../AgentOsDescriptorHost.ts";
import type { KernelAsyncProgramContext } from "../KernelAsyncProgram.ts";
import { KERNEL_WNOHANG } from "../KernelProcessTable.ts";
import { KernelProcessCancelledError } from "../process/KernelProcessCancellation.ts";
import { mapErrno, runAsync } from "../wasi/internal_wasi_calls.ts";
import type { KernelGitCredentials } from "./KernelGitCredentials.ts";
import {
  decodeGitBytes,
  decodeGitEnvironment,
  decodeGitStrings,
  encodeGitWaitStatus,
  gitErrnoForKernelError,
  gitErrnoOf,
  gitSpawnFileAction,
  GIT_ERRNO,
  validGitMemoryRange,
} from "./KernelGitProcessWire.ts";

const {
  fault: EFAULT,
  invalidArgument: EINVAL,
  noChild: ECHILD,
  io: EIO,
  unsupported: ENOTSUP,
} = GIT_ERRNO;

interface GitProcessImportOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly context: KernelAsyncProgramContext;
  readonly credentials: KernelGitCredentials;
}

interface GitChild {
  readonly request: AgentOsSpawnRequest;
  handle?: KernelHandle<"process">;
  kernelPid?: number;
}

/** Maps Nimbus's no-fork child ABI into the kernel's process and descriptor tables. */
export class KernelGitProcessImports {
  readonly imports: Readonly<Record<string, WebAssembly.ImportValue>>;
  readonly suspendingImports = Object.freeze(["dup2", "spawn", "start", "wait"] as const);
  readonly #options: GitProcessImportOptions;
  readonly #descriptors: AgentOsDescriptorHost;
  readonly #children = new Map<number, GitChild>();
  #nextPid = 1;

  constructor(options: GitProcessImportOptions) {
    this.#options = options;
    this.#descriptors = new AgentOsDescriptorHost({
      memory: options.memory,
      descriptors: options.context.filesystem.descriptors,
      wakes: options.context.wakes,
      asyncMode: true,
      currentSignal: () => options.context.signal,
    });
    this.imports = Object.freeze({
      ids: (pointer: number) => this.#ids(pointer),
      startup_cwd: (pointer: number, capacity: number) => this.#startupCwd(pointer, capacity),
      pipe: (fdsPointer: number) => this.#pipe(fdsPointer),
      dup: (fd: number, outPointer: number) => this.#dup(fd, outPointer),
      dup2: (from: number, to: number) => this.#dup2(from, to),
      kill: (pid: number, signal: number) => this.#kill(pid, signal),
      wait: (pid: number, options: number, statusPointer: number, waitedPointer: number) =>
        this.#wait(pid, options, statusPointer, waitedPointer),
      spawn: (
        argvPointer: number,
        argvLength: number,
        envPointer: number,
        envLength: number,
        cwdPointer: number,
        cwdLength: number,
        stdinFd: number,
        stdoutFd: number,
        stderrFd: number,
        pidPointer: number,
      ) =>
        this.#spawn(
          argvPointer,
          argvLength,
          envPointer,
          envLength,
          cwdPointer,
          cwdLength,
          stdinFd,
          stdoutFd,
          stderrFd,
          pidPointer,
        ),
      start: (pid: number) => this.#start(pid),
    });
  }

  getImportObject(): Record<string, WebAssembly.ImportValue> {
    const wasm = WebAssembly as unknown as {
      Suspending?: new (
        fn: (...args: number[]) => number | Promise<number>,
      ) => WebAssembly.ImportValue;
    };
    if (typeof wasm.Suspending !== "function") {
      throw Object.assign(new Error("Git child imports require WebAssembly JSPI"), {
        code: "ERR_KERNEL_JSPI_UNAVAILABLE",
      });
    }
    const imports = Object.create(null) as Record<string, WebAssembly.ImportValue>;
    for (const [name, handler] of Object.entries(this.imports)) {
      imports[name] = this.suspendingImports.includes(name as "dup2" | "spawn" | "start" | "wait")
        ? new wasm.Suspending(handler as (...args: number[]) => number | Promise<number>)
        : handler;
    }
    return imports;
  }

  #ids(pointer: number) {
    const memory = this.#options.memory();
    if (!validGitMemoryRange(memory, pointer, 8)) return EFAULT;
    const view = new DataView(memory.buffer);
    view.setUint32(pointer >>> 0, this.#options.credentials.uid, true);
    view.setUint32((pointer >>> 0) + 4, this.#options.credentials.gid, true);
    return 0;
  }

  #startupCwd(pointer: number, capacity: number) {
    const memory = this.#options.memory();
    const cwd = new TextEncoder().encode(this.#options.context.filesystem.cwd);
    const size = capacity >>> 0;
    if (size === 0) return cwd.byteLength;
    if (size <= cwd.byteLength) return -GIT_ERRNO.noSpace;
    if (!validGitMemoryRange(memory, pointer, cwd.byteLength + 1)) return -GIT_ERRNO.fault;
    const output = new Uint8Array(memory.buffer, pointer >>> 0, cwd.byteLength + 1);
    output.set(cwd);
    output[cwd.byteLength] = 0;
    return cwd.byteLength;
  }

  #pipe(fdsPointer: number) {
    const start = fdsPointer >>> 0;
    if (!validGitMemoryRange(this.#options.memory(), start, 8)) return EFAULT;
    return this.#descriptors.imports.fd_pipe(start, start + 4);
  }

  #dup(fd: number, outPointer: number) {
    const memory = this.#options.memory();
    if (!validGitMemoryRange(memory, outPointer, 4)) return EFAULT;
    try {
      const duplicate = this.#options.context.filesystem.descriptors.duplicate(fd | 0, {
        closeOnExec: false,
      });
      new DataView(memory.buffer).setInt32(outPointer >>> 0, duplicate, true);
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  async #dup2(from: number, to: number) {
    try {
      const result = this.#options.context.filesystem.descriptors.duplicateTo(from | 0, to | 0, {
        closeOnExec: false,
      });
      await runAsync(result);
      return 0;
    } catch (error) {
      return mapErrno(error);
    }
  }

  #kill(pid: number, signal: number) {
    if (this.#options.context.signal.aborted)
      throw new KernelProcessCancelledError("Git execution was cancelled");
    const child = this.#children.get(pid | 0);
    if (!child?.handle) return GIT_ERRNO.noProcess;
    const result = this.#options.context.processes.signal(child.handle, signal >>> 0);
    if (result.status === "would_block") {
      this.#options.context.wakes.release(result.wakeToken);
      return GIT_ERRNO.again;
    }
    if (result.status === "error" && result.error.code === "NOT_FOUND") return GIT_ERRNO.noProcess;
    return gitErrnoOf(result);
  }

  async #wait(pid: number, options: number, statusPointer: number, waitedPointer: number) {
    const memory = this.#options.memory();
    if (
      !validGitMemoryRange(memory, statusPointer, 4) ||
      !validGitMemoryRange(memory, waitedPointer, 4)
    )
      return EFAULT;
    if (((options >>> 0) & ~KERNEL_WNOHANG) !== 0) return EINVAL;
    if ((pid | 0) <= 0) return ENOTSUP;
    const child = this.#children.get(pid | 0);
    if (child?.kernelPid === undefined) return ECHILD;
    const result = await this.#waitForChild(child.kernelPid, options >>> 0);
    if (result.status === "error") return gitErrnoForKernelError(result.error.code);
    const view = new DataView(memory.buffer);
    if (!("status" in result.value)) {
      view.setInt32(statusPointer >>> 0, 0, true);
      view.setInt32(waitedPointer >>> 0, 0, true);
      return 0;
    }
    const status = result.value.status;
    view.setInt32(statusPointer >>> 0, encodeGitWaitStatus(status), true);
    view.setInt32(waitedPointer >>> 0, pid | 0, true);
    this.#children.delete(pid | 0);
    return 0;
  }

  async #spawn(
    argvPointer: number,
    argvLength: number,
    envPointer: number,
    envLength: number,
    cwdPointer: number,
    cwdLength: number,
    stdinFd: number,
    stdoutFd: number,
    stderrFd: number,
    pidPointer: number,
  ) {
    const memory = this.#options.memory();
    if (!validGitMemoryRange(memory, pidPointer, 4)) return EFAULT;
    const argv = decodeGitStrings(memory, argvPointer, argvLength);
    const envStrings = decodeGitStrings(memory, envPointer, envLength);
    const cwd = decodeGitBytes(memory, cwdPointer, cwdLength);
    if (typeof argv === "number") return argv;
    if (typeof envStrings === "number") return envStrings;
    if (typeof cwd === "number") return cwd;
    if (argv.length === 0 || !argv[0]) return EINVAL;
    const env = decodeGitEnvironment(envStrings);
    if (env === undefined) return EINVAL;
    const actions = [
      gitSpawnFileAction(0, stdinFd),
      gitSpawnFileAction(1, stdoutFd),
      gitSpawnFileAction(2, stderrFd),
    ];
    let request: AgentOsSpawnRequest;
    try {
      request = Object.freeze({
        execPath: argv[0],
        argv: Object.freeze([...argv]),
        env: Object.freeze(env),
        actions: Object.freeze(actions),
        ...(cwd.length === 0 ? {} : { cwd }),
        attributes: Object.freeze({
          flags: 0,
          defaultMask: Object.freeze({ low: 0, high: 0 }),
          signalMask: Object.freeze({ low: 0, high: 0 }),
          processGroup: 0,
        }),
        pidPointer: pidPointer >>> 0,
      });
    } catch {
      return EINVAL;
    }
    const pid = this.#allocatePid();
    if (pid === undefined) return GIT_ERRNO.resourceLimit;
    this.#children.set(pid, { request });
    new DataView(memory.buffer).setInt32(pidPointer >>> 0, pid, true);
    return 0;
  }

  async #start(pid: number) {
    if (this.#options.context.signal.aborted)
      throw new KernelProcessCancelledError("Git execution was cancelled");
    const childPid = pid | 0;
    const child = this.#children.get(childPid);
    if (!child) return ECHILD;
    if (child.handle) return 0;
    let spawned: KernelResult<KernelHandle<"process">>;
    try {
      spawned = await this.#options.context.spawn(child.request);
    } catch {
      if (this.#options.context.signal.aborted)
        throw new KernelProcessCancelledError("Git execution was cancelled");
      this.#children.delete(childPid);
      return EIO;
    }
    if (this.#options.context.signal.aborted)
      throw new KernelProcessCancelledError("Git execution was cancelled");
    if (spawned.status === "would_block") {
      this.#options.context.wakes.release(spawned.wakeToken);
      this.#children.delete(childPid);
      return GIT_ERRNO.resourceLimit;
    }
    if (spawned.status !== "ok") {
      this.#children.delete(childPid);
      return gitErrnoOf(spawned);
    }
    const process = this.#options.context.processes.info(spawned.value);
    if (process.status === "would_block") {
      this.#options.context.wakes.release(process.wakeToken);
      this.#children.delete(childPid);
      return GIT_ERRNO.resourceLimit;
    }
    if (process.status !== "ok") {
      this.#children.delete(childPid);
      return gitErrnoOf(process);
    }
    child.handle = spawned.value;
    child.kernelPid = process.value.pid;
    return 0;
  }

  #allocatePid(): number | undefined {
    let candidate = this.#nextPid;
    for (let attempts = 0; attempts <= this.#children.size; attempts++) {
      if (candidate > 0x7fff_ffff) candidate = 1;
      this.#nextPid = candidate === 0x7fff_ffff ? 1 : candidate + 1;
      if (!this.#children.has(candidate)) return candidate;
      candidate = this.#nextPid;
    }
    return undefined;
  }

  async #waitForChild(pid: number, options: number) {
    for (;;) {
      if (this.#options.context.signal.aborted) {
        throw new KernelProcessCancelledError("Git child wait cancelled");
      }
      const result = this.#options.context.processes.waitpid(
        this.#options.context.identity.handle,
        pid,
        options,
      );
      if (result.status !== "would_block") return result;
      const token = result.wakeToken;
      try {
        const woken = await this.#options.context.wakes.wait(token, this.#options.context.signal);
        if (woken.status !== "ok") {
          if (this.#options.context.signal.aborted)
            throw new KernelProcessCancelledError("Git child wait cancelled");
          return kernelError("CANCELLED", woken.error.message);
        }
      } finally {
        this.#options.context.wakes.release(token);
      }
    }
  }
}
