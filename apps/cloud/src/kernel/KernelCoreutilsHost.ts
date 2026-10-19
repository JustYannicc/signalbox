import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelCoreutilsImports } from "./KernelCoreutilsImports.ts";
import type {
  KernelCoreutilsCall,
  KernelCoreutilsCallResult,
  KernelCoreutilsPort,
} from "./KernelCoreutilsPort.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { SyscallMemory } from "./syscall/SyscallMemory.ts";

export interface KernelCoreutilsHostOptions {
  readonly context: KernelAsyncProgramContext;
}

/** Borrows the admitted process resources. No guest module or linear memory lives here. */
export function createKernelCoreutilsHost({ context }: KernelCoreutilsHostOptions) {
  const credentials = credentialsFor(context);
  const memory = new SyscallMemory();
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal.reason);
  const syscalls = createKernelSyscallHost({
    filesystem: context.filesystem,
    args: [...context.args],
    env: context.env,
    signal: controller.signal,
    agentOsPreopens: true,
  });
  const imports = createKernelCoreutilsImports({
    memory: () => memory,
    fileSystem: context.filesystem,
    wakes: context.wakes,
    asyncMode: true,
    currentSignal: () => controller.signal,
    credentials,
  });
  const handlers = new Map<string, (...args: (number | bigint)[]) => unknown>();
  for (const [namespace, value] of Object.entries(imports)) {
    if (typeof value !== "object" || value === null) continue;
    for (const [name, handler] of Object.entries(value)) {
      if (typeof handler === "function") {
        handlers.set(`${namespace}.${name}`, handler as (...args: (number | bigint)[]) => unknown);
      }
    }
  }

  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  let closed = false;
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const operation = <T>(run: () => Promise<T> | T): Promise<T> => {
    if (closed || active !== undefined) {
      return Promise.reject(
        new Error("Coreutils process port is unavailable or already executing"),
      );
    }
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

  const port: KernelCoreutilsPort = {
    call: (request) => operation(() => syscalls.call(request)),
    callCoreutils: (request: KernelCoreutilsCall): Promise<KernelCoreutilsCallResult> =>
      operation(async () => {
        const key = `${request.namespace}.${request.name}`;
        const handler = handlers.get(key);
        if (handler === undefined) throw new Error(`Unknown coreutils import ${key}`);
        memory.bind(request.memorySize, request.regions);
        try {
          const value = (await Reflect.apply(handler, undefined, request.args)) as number | bigint;
          return { value, regions: memory.snapshot() };
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

function credentialsFor(context: KernelAsyncProgramContext) {
  const credentials = context.filesystem.posixPolicy?.credentials;
  if (credentials === undefined) {
    throw new Error("Coreutils requires the admitted filesystem POSIX identity");
  }
  return {
    uid: credentials.uid,
    gid: credentials.gid,
    effectiveUid: credentials.euid,
    effectiveGid: credentials.egid,
  };
}
