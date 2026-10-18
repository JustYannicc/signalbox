// Asyncify process transitions follow Nimbus e9f019ab4e40cb6037aff7e1a0eaf20842578ed3.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import { AgentOsDescriptorHost } from "../AgentOsDescriptorHost.ts";
import { range, string, flatStrings, environment, errno, resultErrno } from "./BashMemory.ts";
import { createBashEnvironment } from "./BashEnvironment.ts";
import { createKernelNimbusMetadata } from "../KernelNimbusMetadata.ts";
import type { BashProcess } from "./BashProcess.ts";

type Suspending = new (handler: (...args: number[]) => Promise<number>) => WebAssembly.ImportValue;

export function bashImports(process: BashProcess): WebAssembly.Imports {
  const { context } = process;
  const memory = () => process.exports.memory;
  const descriptors = context.filesystem.descriptors;
  const descriptorHost = new AgentOsDescriptorHost({
    memory,
    descriptors,
    wakes: context.wakes,
    asyncMode: true,
    currentSignal: () => context.signal,
  });
  const metadata = createKernelNimbusMetadata({
    memory,
    filesystem: context.filesystem,
    credentials: process.credentials,
    directoryFd: (fd) => Number(process.preopens.transformArguments("path_open", [fd])[0]),
  });
  const suspend = (handler: (...args: number[]) => Promise<number>): WebAssembly.ImportValue => {
    const wasm = WebAssembly as unknown as { Suspending: Suspending };
    return new wasm.Suspending(handler);
  };
  const landing = (): boolean => {
    if (!process.rewinding) return false;
    process.exports.asyncify_stop_rewind();
    process.rewinding = false;
    return true;
  };
  const transition = (reason: NonNullable<BashProcess["pending"]>): number => {
    process.pending = reason;
    const at = process.captures.unwindAt(
      memory(),
      Number(process.exports.__stack_pointer.value),
      process.stats,
      context.identity.pid,
    );
    process.exports.asyncify_start_unwind(at);
    return 0;
  };
  const fork = () => (landing() ? process.resume : transition({ kind: "fork" }));
  const nimbus = {
    startup_cwd: (pointer: number, capacity: number) => {
      try {
        const bytes = new TextEncoder().encode(context.filesystem.cwd);
        if (capacity === 0) return bytes.length;
        if (capacity >>> 0 <= bytes.length) return -68;
        const target = range(memory(), pointer, bytes.length + 1);
        target.set(bytes);
        target[bytes.length] = 0;
        return bytes.length;
      } catch (error) {
        return -errno(error);
      }
    },
    capture_cwd: (pointer: number, length: number) => {
      try {
        context.filesystem.chdir(string(memory(), pointer, length));
        return 0;
      } catch (error) {
        return errno(error);
      }
    },
    setjmp: (env: number) => {
      if (landing()) return;
      range(memory(), env, 12);
      process.captures.setting(memory(), env);
      transition({ kind: "capture", env, stack: Number(process.exports.__stack_pointer.value) });
    },
    longjmp: (env: number, value: number) => {
      if (landing()) return;
      range(memory(), env, 12);
      transition({ kind: "longjmp", env, value: value || 1 });
    },
    fork,
    vfork: fork,
    execve: (path: number, argv: number, argvLength: number, env: number, envLength: number) => {
      if (landing()) return process.resume;
      try {
        return transition({
          kind: "exec",
          path: string(memory(), path),
          args: flatStrings(memory(), argv, argvLength),
          env: environment(flatStrings(memory(), env, envLength)),
        });
      } catch (error) {
        return -errno(error);
      }
    },
    waitpid: (pid: number, status: number, options: number) => {
      if (landing()) return process.resume;
      try {
        if (status !== 0) range(memory(), status, 4);
      } catch (error) {
        return -errno(error);
      }
      return transition({ kind: "wait", pid, status, options });
    },
    pipe: (pointer: number) => {
      const result = descriptorHost.imports.fd_pipe(pointer, (pointer >>> 0) + 4);
      return result === 0 ? 0 : -result;
    },
    fd_getfd: (fd: number) => {
      try {
        descriptors.get(fd >>> 0);
        return 0;
      } catch (error) {
        return errno(error);
      }
    },
    dup: (fd: number) => {
      try {
        return descriptors.duplicate(fd >>> 0);
      } catch (error) {
        return -errno(error);
      }
    },
    dup2: suspend(async (oldFd: number, newFd: number) => {
      try {
        return await process.preopens.duplicateTo(oldFd >>> 0, newFd >>> 0);
      } catch (error) {
        return -errno(error);
      }
    }),
    kill: (pid: number, signal: number) => {
      const result = context.processes.signalPid(context.identity.handle, pid, signal);
      return result.status === "ok" ? 0 : -resultErrno(result, "kill");
    },
    getppid: () => {
      const result = context.processes.info(context.identity.handle);
      return result.status === "ok" ? result.value.parentPid : -resultErrno(result, "getppid");
    },
    getpgid: (pid: number) => {
      const result =
        pid === 0 || pid === context.identity.pid
          ? context.processes.info(context.identity.handle)
          : context.processes.lookupPid(pid);
      return result.status === "ok"
        ? "info" in result.value
          ? result.value.info.processGroupId
          : result.value.processGroupId
        : -resultErrno(result, "getpgid");
    },
    setpgid: (_pid: number, _group: number) => -58,
    tcgetpgrp: (_fd: number) => -59,
    tcsetpgrp: (_fd: number, _group: number) => -59,
    tcgetattr: (_fd: number, _termios: number) => -59,
    tcsetattr: (_fd: number, _action: number, _termios: number) => -59,
    ...metadata,
  };
  return {
    wasi_snapshot_preview1: process.lifecycle.wasiImport,
    nimbus_proc: nimbus,
    env: createBashEnvironment({
      memory,
      credentials: process.credentials,
      filesystem: context.filesystem,
      pid: () => context.identity.pid,
    }),
    nimbus_procenv: { full: () => process.captures.applyLog(memory()) },
  };
}
