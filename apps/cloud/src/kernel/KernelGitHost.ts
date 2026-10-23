import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import type { KernelGitPort, KernelGitCall } from "./KernelGitPort.ts";
import { KernelGitFilesystemImports } from "./git/KernelGitFilesystemImports.ts";
import { KernelGitProcessImports } from "./git/KernelGitProcessImports.ts";
import { validateGitCredentials, type KernelGitCredentials } from "./git/KernelGitCredentials.ts";
import { SyscallMemory } from "./syscall/SyscallMemory.ts";

export interface KernelGitHostOptions {
  readonly context: KernelAsyncProgramContext;
}

type GitImport = (...args: readonly number[]) => number | Promise<number>;

/** Keeps WASM state in its worker while Git reuses the admitted process resources. */
export function createKernelGitHost({ context }: KernelGitHostOptions) {
  const process = context.processes.info(context.identity.handle);
  if (process.status !== "ok")
    throw Object.assign(new Error("Git process identity is unavailable"), { code: "ESRCH" });

  const credentials = credentialsFor(context);
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal.reason);
  const ownedContext = { ...context, signal: controller.signal };
  const memory = new SyscallMemory();
  const filesystem = new KernelGitFilesystemImports({
    memory: () => memory,
    filesystem: context.filesystem,
    credentials,
  });
  const processes = new KernelGitProcessImports({
    memory: () => memory,
    context: ownedContext,
    credentials,
  });
  const gitImports = new Map<string, GitImport>();
  addImports(gitImports, "nimbus_fs", filesystem.imports);
  addImports(gitImports, "nimbus_proc", processes.imports);
  const syscalls = createKernelSyscallHost({
    process: context,
    filesystem: context.filesystem,
    args: context.args,
    env: context.env,
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
      return Promise.reject(new Error("Git process port is unavailable or already executing"));
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

  const port: KernelGitPort = {
    call: (request) => operation(() => syscalls.call(request)),
    callGit: (request) => operation(() => callGit(request)),
  };

  async function callGit(request: KernelGitCall) {
    const handler = gitImports.get(`${request.namespace}.${request.name}`);
    if (handler === undefined)
      throw new Error(`Unknown Git syscall ${request.namespace}.${request.name}`);
    try {
      memory.bind(request.memorySize, request.regions);
      return { value: await handler(...request.args), regions: memory.snapshot() };
    } finally {
      memory.clear();
    }
  }

  return {
    port,
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closed = true;
      const close = (async () => {
        controller.abort(context.signal.reason);
        await active?.catch(() => {});
        const errors: unknown[] = [];
        try {
          await processes.cleanupChildren();
        } catch (error) {
          errors.push(error);
        }
        try {
          syscalls.close();
        } catch (error) {
          errors.push(error);
        } finally {
          memory.clear();
          context.signal.removeEventListener("abort", abort);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Git host cleanup failed", { cause: errors.at(-1) });
      })();
      closing = close.catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}

function credentialsFor(context: KernelAsyncProgramContext): KernelGitCredentials {
  const policy = context.filesystem.posixPolicy;
  if (policy === undefined)
    throw new RangeError("Git requires an explicit filesystem POSIX policy");
  return validateGitCredentials({
    uid: policy.credentials.uid,
    gid: policy.credentials.gid,
    euid: policy.credentials.euid,
    egid: policy.credentials.egid,
  });
}

function addImports(
  target: Map<string, GitImport>,
  namespace: "nimbus_fs" | "nimbus_proc",
  imports: Readonly<Record<string, WebAssembly.ImportValue>>,
): void {
  for (const [name, value] of Object.entries(imports)) {
    if (typeof value !== "function")
      throw new TypeError(`Git import ${namespace}.${name} is not callable`);
    target.set(`${namespace}.${name}`, value as GitImport);
  }
}
