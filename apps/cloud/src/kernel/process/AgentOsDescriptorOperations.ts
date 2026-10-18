import { mapErrno, runAsync, runSync, type WasiCall } from "../wasi/internal_wasi_calls.ts";
import { runCurrentKernelCpuAsyncSystemImport } from "../KernelCpuExecution.ts";
import type { AgentOsDescriptorHostOptions } from "./AgentOsDescriptorSupport.ts";
import { validRange, writeU32 } from "./AgentOsDescriptorSupport.ts";

const EBADF = 8;
const EFAULT = 21;
const EINVAL = 28;
const EIO = 29;
const EMFILE = 33;
const ENOTSUP = 58;
const FD_CLOEXEC = 1;
const MAX_ALLOCATED_FD = 0x7fff_ffff;
const MAX_I64 = (1n << 63n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;

export interface AgentOsDescriptorImports {
  fd_pipe: (readPointer: number, writePointer: number) => number;
  fd_dup: (fd: number, resultPointer: number) => number;
  fd_dup2: (oldFd: number, newFd: number) => number | Promise<number>;
  fd_dup_min: (fd: number, minFd: number, resultPointer: number) => number;
  fd_setfd: (fd: number, flags: number) => number;
  fd_getfd: (fd: number, resultPointer: number) => number;
  proc_closefrom: (lowFd: number) => number | Promise<number>;
  fd_record_lock: (
    fd: number,
    command: number,
    lockType: number,
    start: bigint,
    length: bigint,
    resultTypePointer: number,
    resultPidPointer: number,
    resultStartPointer: number,
    resultLengthPointer: number,
  ) => number;
}

type SynchronousImports = Omit<AgentOsDescriptorImports, "fd_pipe">;

export class AgentOsDescriptorOperations {
  readonly imports: SynchronousImports;
  readonly suspendingImports: readonly string[];
  readonly #options: AgentOsDescriptorHostOptions;

  constructor(options: AgentOsDescriptorHostOptions) {
    this.#options = options;
    this.suspendingImports = Object.freeze(options.asyncMode ? ["fd_dup2", "proc_closefrom"] : []);
    this.imports = Object.freeze({
      fd_dup: (fd: number, resultPointer: number) => this.#duplicate(fd, resultPointer),
      fd_dup2: (oldFd: number, newFd: number) => this.#duplicateTo(oldFd, newFd),
      fd_dup_min: (fd: number, minFd: number, resultPointer: number) =>
        this.#duplicateAtLeast(fd, minFd, resultPointer),
      fd_setfd: (fd: number, flags: number) => this.#setDescriptorFlags(fd, flags),
      fd_getfd: (fd: number, resultPointer: number) => this.#getDescriptorFlags(fd, resultPointer),
      proc_closefrom: (lowFd: number) => this.#closeFrom(lowFd),
      fd_record_lock: (
        fd: number,
        command: number,
        lockType: number,
        start: bigint,
        length: bigint,
        resultType: number,
        resultPid: number,
        resultStart: number,
        resultLength: number,
      ) =>
        this.#recordLock(
          fd,
          command,
          lockType,
          start,
          length,
          resultType,
          resultPid,
          resultStart,
          resultLength,
        ),
    });
  }

  #duplicate(fd: number, resultPointer: number): number {
    const memory = this.#options.memory();
    if (!validRange(memory, resultPointer, 4)) return EFAULT;
    try {
      const duplicate = this.#options.descriptors.duplicate(fd >>> 0, { closeOnExec: false });
      writeU32(memory, resultPointer, duplicate);
      return 0;
    } catch (error) {
      return toErrno(error);
    }
  }

  #duplicateAtLeast(fd: number, minFd: number, resultPointer: number): number {
    const memory = this.#options.memory();
    if (!validRange(memory, resultPointer, 4)) return EFAULT;
    const sourceFd = fd >>> 0;
    const minimum = minFd >>> 0;
    try {
      this.#options.descriptors.get(sourceFd);
      if (minimum > MAX_ALLOCATED_FD) return EINVAL;
      const occupiedCount = Array.from(this.#options.descriptors.entries()).length;
      let targetFd = minimum;
      for (let attempt = 0; attempt <= occupiedCount; attempt++, targetFd++) {
        if (targetFd > MAX_ALLOCATED_FD) return EMFILE;
        if (this.#options.descriptors.has(targetFd)) continue;
        runSync(this.#options.descriptors.duplicateTo(sourceFd, targetFd, { closeOnExec: false }));
        writeU32(memory, resultPointer, targetFd);
        return 0;
      }
      return EMFILE;
    } catch (error) {
      return toErrno(error);
    }
  }

  #duplicateTo(oldFd: number, newFd: number): number | Promise<number> {
    const sourceFd = oldFd >>> 0;
    const targetFd = newFd >>> 0;
    try {
      this.#options.descriptors.get(sourceFd);
      if (targetFd > MAX_ALLOCATED_FD) {
        return this.#options.asyncMode ? Promise.resolve(EBADF) : EBADF;
      }
      const call = this.#options.descriptors.duplicateTo(sourceFd, targetFd, {
        closeOnExec: false,
      });
      return this.#options.asyncMode
        ? this.#finishDuplicateToAsync(call)
        : this.#finishDuplicateToSync(call);
    } catch (error) {
      const errno = toErrno(error);
      return this.#options.asyncMode ? Promise.resolve(errno) : errno;
    }
  }

  #finishDuplicateToSync(call: WasiCall<number>): number {
    try {
      runSync(call);
      return 0;
    } catch (error) {
      return toErrno(error);
    }
  }

  async #finishDuplicateToAsync(call: WasiCall<number>): Promise<number> {
    try {
      await this.#runAsyncCall(call);
      return 0;
    } catch (error) {
      return toErrno(error);
    }
  }

  #setDescriptorFlags(fd: number, flags: number): number {
    try {
      this.#options.descriptors.get(fd >>> 0).closeOnExec = (flags & FD_CLOEXEC) !== 0;
      return 0;
    } catch (error) {
      return toErrno(error);
    }
  }

  #getDescriptorFlags(fd: number, resultPointer: number): number {
    const memory = this.#options.memory();
    if (!validRange(memory, resultPointer, 4)) return EFAULT;
    try {
      const flags = this.#options.descriptors.get(fd >>> 0).closeOnExec ? FD_CLOEXEC : 0;
      writeU32(memory, resultPointer, flags);
      return 0;
    } catch (error) {
      return toErrno(error);
    }
  }

  #closeFrom(lowFd: number): number | Promise<number> {
    const minimum = lowFd >>> 0;
    const fds = Array.from(this.#options.descriptors.entries(), ([fd]) => fd)
      .filter((fd) => fd >= minimum)
      .sort((left, right) => left - right);
    return this.#options.asyncMode ? this.#closeFromAsync(fds) : this.#closeFromSync(fds);
  }

  #closeFromSync(fds: readonly number[]): number {
    let firstError = 0;
    for (const fd of fds) {
      try {
        runSync(this.#options.descriptors.close(fd));
      } catch (error) {
        const errno = toErrno(error);
        if (errno !== EBADF && firstError === 0) firstError = errno;
      }
    }
    return firstError;
  }

  async #closeFromAsync(fds: readonly number[]): Promise<number> {
    let firstError = 0;
    for (const fd of fds) {
      try {
        await this.#runAsyncCall(this.#options.descriptors.close(fd));
      } catch (error) {
        const errno = toErrno(error);
        if (errno !== EBADF && firstError === 0) firstError = errno;
      }
    }
    return firstError;
  }

  #runAsyncCall<T>(call: WasiCall<T>): Promise<T> {
    // Backend cleanup can await work that never pauses through a wake token.
    return runCurrentKernelCpuAsyncSystemImport((runSystem) => runAsync(call, runSystem));
  }

  #recordLock(
    fd: number,
    command: number,
    lockType: number,
    start: bigint,
    length: bigint,
    _resultTypePointer: number,
    _resultPidPointer: number,
    _resultStartPointer: number,
    _resultLengthPointer: number,
  ): number {
    if (
      ![12, 13, 14].includes(command >>> 0) ||
      ![0, 1, ...(command >>> 0 === 12 ? [] : [2])].includes(lockType >>> 0) ||
      typeof start !== "bigint" ||
      typeof length !== "bigint" ||
      start < 0n ||
      start > MAX_I64 ||
      length < 0n ||
      length > MAX_U64
    ) {
      return EINVAL;
    }
    try {
      this.#options.descriptors.get(fd >>> 0);
    } catch (error) {
      return toErrno(error);
    }
    // Without a shared inode lock manager, reporting success would lie across processes.
    return ENOTSUP;
  }
}

function toErrno(error: unknown): number {
  try {
    return mapErrno(error);
  } catch {
    return EIO;
  }
}
