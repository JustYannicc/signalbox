import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelBusyboxPort } from "./KernelBusyboxPort.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import {
  createKernelBusyboxNamedImports,
  KERNEL_BUSYBOX_IMPORT_NAMES,
} from "./coreutils/KernelBusyboxImports.ts";
import { SyscallMemory } from "./syscall/SyscallMemory.ts";

export interface KernelBusyboxHostOptions {
  readonly context: KernelAsyncProgramContext;
}

/** Borrows the admitted process resources. No guest module or linear memory lives here. */
export function createKernelBusyboxHost({ context }: KernelBusyboxHostOptions) {
  const process = context.processes.info(context.identity.handle);
  if (process.status !== "ok")
    throw Object.assign(new Error("BusyBox process identity is unavailable"), { code: "ESRCH" });

  const memory = new SyscallMemory();
  const imports = createKernelBusyboxNamedImports({
    names: KERNEL_BUSYBOX_IMPORT_NAMES,
    memory: () => memory,
    filesystem: context.filesystem,
    pid: context.identity.pid,
    parentPid: process.value.parentPid,
  });
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal.reason);
  const syscalls = createKernelSyscallHost({
    process: context,
    ...context,
    signal: controller.signal,
    agentOsPreopens: true,
  });
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  let closed = false;
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const operation = <T>(run: () => Promise<T> | T): Promise<T> => {
    if (closed || active !== undefined)
      return Promise.reject(new Error("BusyBox process port is unavailable or already executing"));
    const result = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return run();
    });
    active = result;
    void result.then(
      () => {
        active = undefined;
      },
      () => {
        active = undefined;
      },
    );
    return result;
  };
  const port: KernelBusyboxPort = {
    call: (request) => operation(() => syscalls.call(request)),
    callBusybox: (request) =>
      operation(() => {
        const handler = imports[request.name];
        if (handler === undefined)
          throw new Error(`Unknown BusyBox syscall nimbus_proc.${request.name}`);
        try {
          memory.bind(request.memorySize, request.regions);
          return { value: handler(...request.args), regions: memory.snapshot() };
        } finally {
          memory.clear();
        }
      }),
  };
  return {
    port,
    close(): Promise<void> {
      return (closing ??= (async () => {
        closed = true;
        controller.abort();
        await active?.catch(() => {});
        context.signal.removeEventListener("abort", abort);
        syscalls.close();
        memory.clear();
      })());
    },
  };
}
