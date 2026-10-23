import { kernelError, kernelOk, type KernelResult } from "./KernelAbi.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import type { KernelAsyncProgramCpu } from "./KernelAsyncProgram.ts";
import type { KernelBashCredentials, KernelBashProgramContext } from "./KernelBashProgram.ts";
import type { KernelBashCompletion, KernelBashPort } from "./KernelBashPort.ts";
import type { KernelExitStatus } from "./KernelProcessTable.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { createBashHostImports } from "./bash/BashHostImports.ts";
import { assertBashPosixCredentials } from "./bash/BashEnvironment.ts";
import { errno, resultErrno } from "./bash/BashMemory.ts";
import { BashPreopens } from "./bash/BashPreopens.ts";
import { KernelProcessCancelledError } from "./process/KernelProcessCancellation.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import { SyscallMemory } from "./syscall/SyscallMemory.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";

export interface KernelBashHostOptions {
  readonly context: KernelBashProgramContext;
  readonly credentials: KernelBashCredentials;
}

interface BashHostNode {
  readonly parent: BashHostNode | undefined;
  readonly context: KernelBashProgramContext;
  readonly port: KernelBashPort;
  readonly completion: Promise<KernelExitStatus>;
  readonly ready: Promise<void>;
  abort(): void;
  finish(result: KernelBashCompletion): void;
  signal(signal: number): KernelResult<void>;
  close(): Promise<void>;
  dispose(): void;
}

/** The returned port borrows the root context. close releases only this bridge's forked resources. */
export function createKernelBashHost(options: KernelBashHostOptions) {
  const nodes = new Set<BashHostNode>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function create(
    supplied: KernelBashProgramContext,
    inherited: KernelBashCredentials,
    parent?: BashHostNode,
    parentPreopens?: BashPreopens,
  ): BashHostNode {
    assertBashPosixCredentials(inherited, supplied.filesystem);
    const controller = new AbortController();
    const abort = () => controller.abort(supplied.signal.reason);
    supplied.signal.addEventListener("abort", abort, { once: true });
    if (supplied.signal.aborted) abort();
    const context = { ...supplied, signal: controller.signal };
    const credentials = {
      ...inherited,
      umask: supplied.filesystem.posixPolicy?.umask ?? inherited.umask,
    };
    const preopens = new BashPreopens(context.filesystem.descriptors, parentPreopens);
    const syscalls = createKernelSyscallHost({ ...context, process: context });
    const memory = new SyscallMemory();
    const namespaces = createBashHostImports(context, credentials, () => memory, preopens);
    const imports = new Map<string, (...args: number[]) => number | Promise<number>>(
      Object.entries(namespaces).flatMap(([namespace, handlers]) =>
        Object.entries(handlers).map(([name, handler]) => [`${namespace}.${name}`, handler]),
      ),
    );
    const completion = Promise.withResolvers<KernelExitStatus>();
    // The root is completed by the caller's program host, outside this process table.
    void completion.promise.catch(() => {});
    let completed = false;
    let active: Promise<unknown> | undefined;
    let sentSignal = 0;
    let disposed = false;

    const operation = <T>(run: () => Promise<T> | T): Promise<T> => {
      if (closed || completed || active !== undefined)
        return Promise.reject(new Error("Bash process port is unavailable or already executing"));
      const execute = () =>
        Promise.resolve().then(() => {
          context.signal.throwIfAborted();
          return run();
        });
      const result = context.cpu === undefined ? execute() : context.cpu.run(execute);
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
    const finish = (result: KernelBashCompletion) => {
      if (completed) return;
      completed = true;
      if (sentSignal !== 0)
        completion.resolve({ exitCode: 0, signal: sentSignal, coreDumped: false });
      else if (result.kind === "exit") completion.resolve(result.status);
      else {
        completion.reject(
          context.signal.aborted
            ? new KernelProcessCancelledError(result.message)
            : new Error(result.message),
        );
        for (const child of nodes) if (descendsFrom(child, node)) child.abort();
      }
    };
    const port: KernelBashPort = {
      call: (request) =>
        operation(() =>
          syscalls.call({
            ...request,
            args: preopens.transformArguments(request.name, request.args),
          }),
        ),
      callBash: (request) =>
        operation(async () => {
          const handler = imports.get(`${request.namespace}.${request.name}`);
          if (handler === undefined)
            throw new Error(`Unknown GNU Bash syscall ${request.namespace}.${request.name}`);
          try {
            memory.bind(request.memorySize, request.regions);
            const value = await handler(...request.args);
            return { value, regions: memory.snapshot() };
          } finally {
            memory.clear();
          }
        }),
      fork: () =>
        operation(async () => {
          const table = context.filesystem.descriptors.fork(
            [...context.filesystem.descriptors.entries()].map(([fd]) => ({
              parentFd: fd,
              childFd: fd,
            })),
            { exec: false },
          );
          let filesystem: typeof context.filesystem;
          try {
            filesystem = context.filesystem.fork(table);
          } catch (error) {
            void runAsync(table.closeAll());
            return { kind: "error" as const, errno: errno(error) };
          }
          let child: BashHostNode | undefined;
          let childCpu: KernelAsyncProgramCpu | undefined;
          const spawned = context.processes.spawn(
            context.identity.handle,
            (identity) => {
              childCpu = context.cpu?.forProcess(identity.pid);
              const launch = () =>
                create(
                  {
                    ...context,
                    filesystem,
                    identity,
                    ...(childCpu === undefined ? {} : { cpu: childCpu }),
                  },
                  credentials,
                  node,
                  preopens,
                );
              child = childCpu === undefined ? launch() : childCpu.run(launch);
              return { completion: child.completion, signal: child.signal };
            },
            async () => {
              const release = async () => {
                try {
                  await runAsync(table.closeAll());
                } finally {
                  filesystem.dispose();
                  child?.dispose();
                }
              };
              try {
                if (childCpu === undefined) await release();
                else await childCpu.run(release);
              } finally {
                childCpu?.stop();
              }
            },
          );
          if (spawned.status !== "ok")
            return { kind: "error" as const, errno: resultErrno(spawned, "fork") };
          return { kind: "fork" as const, pid: spawned.value.pid, port: child!.port };
        }),
      wait: (pid, flags) =>
        operation(async () => {
          for (;;) {
            const result = context.processes.waitpid(context.identity.handle, pid, flags);
            if (result.status === "ok") {
              if (result.value.pid !== 0) {
                for (const child of nodes) {
                  if (child.parent === node && child.context.identity.pid === result.value.pid)
                    nodes.delete(child);
                }
              }
              return { kind: "wait" as const, ...result.value };
            }
            if (result.status === "error")
              return { kind: "error" as const, errno: resultErrno(result, "waitpid") };
            try {
              const woke = await context.wakes.wait(result.wakeToken, context.signal);
              if (woke.status !== "ok") return { kind: "error" as const, errno: 11 };
            } finally {
              context.wakes.release(result.wakeToken);
            }
          }
        }),
      exec: (request) =>
        operation(async () => {
          try {
            const status = await context.exec({
              ...request,
              filesystem: context.filesystem,
              identity: context.identity,
              signal: context.signal,
              ...(context.home === undefined ? {} : { home: context.home }),
            });
            return { kind: "exit" as const, status };
          } catch (error) {
            if (error instanceof KernelProgramExecAdmissionError)
              return { kind: "error" as const, errno: errno(error) };
            throw error;
          }
        }),
      async complete(result) {
        if (active !== undefined) throw new Error("Bash process still has an active operation");
        finish(result);
      },
    };
    const node: BashHostNode = {
      parent,
      context,
      port,
      completion: completion.promise,
      ready: syscalls.ready,
      abort,
      finish,
      signal(signal: number) {
        if (signal !== 9 && signal !== 15)
          return kernelError("UNSUPPORTED", "Bash signal handlers are unavailable");
        sentSignal = signal;
        controller.abort(new KernelProcessSignal(signal));
        return kernelOk(undefined);
      },
      async close() {
        abort();
        finish({ kind: "failure", message: "GNU Bash child bridge closed" });
        await active?.catch(() => {});
        node.dispose();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        supplied.signal.removeEventListener("abort", abort);
        syscalls.close();
      },
    };
    nodes.add(node);
    return node;
  }

  function descendsFrom(child: BashHostNode, ancestor: BashHostNode): boolean {
    for (let parent = child.parent; parent !== undefined; parent = parent.parent) {
      if (parent === ancestor) return true;
    }
    return false;
  }
  const root = create(options.context, options.credentials);
  return {
    pid: options.context.identity.pid,
    port: root.port,
    ready: root.ready,
    exited: root.completion,
    close(): Promise<void> {
      return (closing ??= (async () => {
        closed = true;
        const owned = [...nodes];
        await Promise.all(owned.map((node) => node.close()));
        for (const node of owned) {
          if (node !== root)
            await options.context.processes.terminateAndReap(node.context.identity.handle);
          node.dispose();
          nodes.delete(node);
        }
      })());
    },
  };
}
