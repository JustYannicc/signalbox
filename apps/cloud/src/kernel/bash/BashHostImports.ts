import { AgentOsDescriptorHost } from "../AgentOsDescriptorHost.ts";
import { createKernelNimbusMetadata } from "../KernelNimbusMetadata.ts";
import type { KernelBashCredentials, KernelBashProgramContext } from "./BashContext.ts";
import type { WasiMemory } from "../wasi/internal_wasi_memory.ts";
import type { BashPreopens } from "./BashPreopens.ts";
import { errno, range, resultErrno, string } from "./BashMemory.ts";

export function createBashHostImports(
  context: KernelBashProgramContext,
  credentials: KernelBashCredentials,
  memory: () => WebAssembly.Memory | WasiMemory,
  preopens: BashPreopens,
) {
  const descriptors = context.filesystem.descriptors;
  const descriptorHost = new AgentOsDescriptorHost({
    memory,
    descriptors,
    wakes: context.wakes,
    asyncMode: true,
    currentSignal: () => context.signal,
  });
  const attempt = (operation: () => number) => {
    try {
      return operation();
    } catch (error) {
      return -errno(error);
    }
  };
  const env = {
    umask: (mask: number) =>
      attempt(() => {
        const next = mask & 0o777;
        const previous =
          context.filesystem.posixPolicy === undefined
            ? credentials.umask
            : context.filesystem.setUmask(next);
        credentials.umask = next;
        return previous;
      }),
  };
  const nimbus = {
    startup_cwd: (pointer: number, capacity: number) =>
      attempt(() => {
        const bytes = new TextEncoder().encode(context.filesystem.cwd);
        if (capacity === 0) return bytes.length;
        if (capacity >>> 0 <= bytes.length) return -68;
        const target = range(memory(), pointer, bytes.length + 1);
        target.set(bytes);
        target[bytes.length] = 0;
        return bytes.length;
      }),
    capture_cwd: (pointer: number, length: number) => {
      try {
        context.filesystem.chdir(string(memory(), pointer, length));
        return 0;
      } catch (error) {
        return errno(error);
      }
    },
    pipe: (pointer: number) => -descriptorHost.imports.fd_pipe(pointer, (pointer >>> 0) + 4),
    fd_getfd: (fd: number) => {
      try {
        descriptors.get(fd >>> 0);
        return 0;
      } catch (error) {
        return errno(error);
      }
    },
    dup: (fd: number) => attempt(() => descriptors.duplicate(fd >>> 0)),
    dup2: async (source: number, target: number) => {
      try {
        return await preopens.duplicateTo(source >>> 0, target >>> 0);
      } catch (error) {
        return -errno(error);
      }
    },
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
  };
  return {
    env,
    nimbus_proc: {
      ...nimbus,
      ...createKernelNimbusMetadata({
        memory,
        filesystem: context.filesystem,
        credentials,
        directoryFd: (fd) => Number(preopens.transformArguments("path_open", [fd])[0]),
      }),
    },
  };
}
