import { kernelError, kernelOk, type KernelResult } from "./KernelAbi.ts";
import { KernelProgramExecAdmissionError } from "./KernelAsyncProgram.ts";
import type { KernelAsyncProgramCpu } from "./KernelAsyncProgram.ts";
import type { KernelBashCredentials, KernelBashProgramContext } from "./KernelBashProgram.ts";
import type {
  KernelBashCompletion,
  KernelBashPort,
  KernelBashWaitResult,
} from "./KernelBashPort.ts";
import { KERNEL_WNOHANG, type KernelExitStatus } from "./KernelProcessTable.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";
import { createBashHostImports } from "./bash/BashHostImports.ts";
import { assertBashPosixCredentials } from "./bash/BashEnvironment.ts";
import { errno, resultErrno } from "./bash/BashMemory.ts";
import { BashPreopens } from "./bash/BashPreopens.ts";
import { KernelProcessCancelledError } from "./process/KernelProcessCancellation.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import { SyscallMemory } from "./syscall/SyscallMemory.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";
import { WasiError } from "./wasi/internal_wasi_memory.ts";
import type { KernelBashForkSource } from "./KernelBashFork.ts";

export interface KernelBashForkHost {
  readonly port: KernelBashPort;
  readonly onDispatchFailure?: (error: unknown) => Promise<void> | void;
  readonly close: () => Promise<void>;
}

export interface KernelBashHostOptions {
  readonly context: KernelBashProgramContext;
  readonly credentials: KernelBashCredentials;
  readonly isStoppedQuotaFailure?: (error: unknown) => boolean;
  readonly runFork?: (
    context: KernelBashProgramContext,
    owner: KernelBashForkHost,
    source: KernelBashForkSource,
  ) => Promise<KernelExitStatus>;
}

interface BashHostNode {
  readonly parent: BashHostNode | undefined;
  readonly context: KernelBashProgramContext;
  readonly port: KernelBashPort;
  readonly completion: Promise<KernelExitStatus>;
  readonly reapedChildren: Map<number, ReapedBashChild>;
  abort(): void;
  finish(result: KernelBashCompletion): void;
  signal(signal: number): KernelResult<void>;
  close(): Promise<void>;
  dispose(): void;
}

interface ReapedBashChild {
  readonly processGroupId: number;
  readonly status: KernelExitStatus;
}

const MAX_PID = 0x7fffffff;
const MAX_CACHED_WAIT_STATUSES = 256;

/** The returned port borrows the root context. close releases only this bridge's forked resources. */
export function createKernelBashHost(options: KernelBashHostOptions) {
  const nodes = new Set<BashHostNode>();
  let cachedWaitStatusCount = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const runFork =
    options.runFork ??
    (async () => {
      throw new WasiError(58);
    });

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
    let remoteStarted = false;

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
      async runFork(source) {
        if (closed || completed || remoteStarted)
          throw Object.assign(new Error("Bash fork is no longer available for placement"), {
            code: "EIO",
          });
        remoteStarted = true;
        try {
          const result = await runFork(
            context,
            {
              port,
              close: () => closeTree(node),
              onDispatchFailure(error) {
                if (options.isStoppedQuotaFailure?.(error)) finish(unstartedForkExit);
              },
            },
            source,
          );
          finish({ kind: "exit", status: result });
          return result;
        } catch (error) {
          if (options.isStoppedQuotaFailure?.(error)) {
            finish(unstartedForkExit);
            throw new WasiError(6);
          }
          finish({ kind: "exit", status: { exitCode: 0, signal: 9, coreDumped: false } });
          throw error;
        }
      },
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
          reapCompletedChildren();
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
            const cached = takeReapedChild(node, pid, flags);
            if (cached !== undefined) return cached;
            const result = context.processes.waitpid(context.identity.handle, pid, flags);
            if (result.status === "ok") {
              if (result.value.pid !== 0) {
                for (const child of nodes) {
                  if (child.parent === node && child.context.identity.pid === result.value.pid)
                    discardNode(child);
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
        if (active !== undefined && !context.signal.aborted)
          throw new Error("Bash process still has an active operation");
        await active?.catch(() => {});
        if (context.signal.aborted) {
          finish({ kind: "exit", status: { exitCode: 0, signal: 9, coreDumped: false } });
          return;
        }
        finish(result);
      },
    };
    const node: BashHostNode = {
      parent,
      context,
      port,
      completion: completion.promise,
      reapedChildren: new Map(),
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
        finish({ kind: "exit", status: { exitCode: 0, signal: 9, coreDumped: false } });
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

  function takeReapedChild(
    node: BashHostNode,
    selector: number,
    flags: number,
  ): KernelBashWaitResult | undefined {
    if (
      node.context.signal.aborted ||
      !Number.isSafeInteger(selector) ||
      selector < -MAX_PID ||
      selector > MAX_PID ||
      !Number.isSafeInteger(flags) ||
      flags < 0 ||
      (flags & ~KERNEL_WNOHANG) !== 0
    )
      return undefined;

    const parent = node.context.processes.info(node.context.identity.handle);
    if (parent.status !== "ok") return undefined;
    const cached = [...node.reapedChildren.entries()]
      .sort(([left], [right]) => left - right)
      .find(
        ([pid, child]) =>
          selector === -1 ||
          (selector === 0 && child.processGroupId === parent.value.processGroupId) ||
          (selector < -1 && child.processGroupId === -selector) ||
          (selector > 0 && pid === selector),
      );
    if (cached === undefined) return undefined;

    const [pid, child] = cached;
    node.reapedChildren.delete(pid);
    cachedWaitStatusCount--;
    return { kind: "wait", pid, status: child.status };
  }

  function discardNode(node: BashHostNode) {
    nodes.delete(node);
    cachedWaitStatusCount -= node.reapedChildren.size;
    node.reapedChildren.clear();
  }

  // Preserve exited-child statuses for Bash while freeing process-table entries before another fork.
  function reapCompletedChildren() {
    for (const child of nodes) {
      if (cachedWaitStatusCount >= MAX_CACHED_WAIT_STATUSES) break;
      const parent = child.parent;
      if (parent === undefined) continue;

      const completed = options.context.processes.lookupPid(child.context.identity.pid);
      if (
        completed.status !== "ok" ||
        completed.value.status !== "exited" ||
        completed.value.info.parentPid !== parent.context.identity.pid
      )
        continue;
      const parentStatus = options.context.processes.lookupPid(parent.context.identity.pid);
      if (parentStatus.status !== "ok" || parentStatus.value.status !== "running") continue;

      const waited = options.context.processes.waitpid(
        parent.context.identity.handle,
        child.context.identity.pid,
        KERNEL_WNOHANG,
      );
      if (
        waited.status !== "ok" ||
        waited.value.pid !== child.context.identity.pid ||
        !("status" in waited.value)
      )
        continue;

      parent.reapedChildren.set(child.context.identity.pid, {
        processGroupId: completed.value.info.processGroupId,
        status: waited.value.status,
      });
      cachedWaitStatusCount++;
      discardNode(child);
    }
  }

  function descendsFrom(child: BashHostNode, ancestor: BashHostNode): boolean {
    for (let parent = child.parent; parent !== undefined; parent = parent.parent) {
      if (parent === ancestor) return true;
    }
    return false;
  }

  const unstartedForkExit = {
    kind: "exit" as const,
    status: { exitCode: 0, signal: 0, coreDumped: false },
  };

  async function closeTree(root: BashHostNode) {
    const owned = [...nodes].filter((node) => node === root || descendsFrom(node, root));
    await Promise.all(owned.map((node) => node.close()));
    for (const node of owned) {
      if (node !== root)
        await options.context.processes.terminateAndReap(node.context.identity.handle);
      node.dispose();
      discardNode(node);
    }
  }

  const root = create(options.context, options.credentials);
  return {
    pid: options.context.identity.pid,
    port: root.port,
    exited: root.completion,
    close(): Promise<void> {
      return (closing ??= (async () => {
        closed = true;
        await closeTree(root);
        nodes.clear();
      })());
    },
  };
}
