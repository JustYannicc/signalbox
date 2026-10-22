// The Asyncify continuation protocol follows Nimbus e9f019ab4e40cb6037aff7e1a0eaf20842578ed3.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import { kernelError, kernelOk } from "../KernelAbi.ts";
import { createKernelWasiFileSystemAdapter } from "../KernelWasiFileSystemAdapter.ts";
import type { KernelExitStatus } from "../KernelProcessTable.ts";
import { kernelProcessSignalExitStatus } from "../KernelProcessSignal.ts";
import { KernelProgramExecAdmissionError } from "../KernelAsyncProgram.ts";
import type { KernelAsyncProgramCpu } from "../KernelAsyncProgram.ts";
import { runKernelExecution } from "../process/KernelExecution.ts";
import { runAsync } from "../wasi/internal_wasi_calls.ts";
import { WasiExit } from "../wasi/internal_wasi_memory.ts";
import { WasiLifecycle } from "../wasi/internal_wasi_lifecycle.ts";
import { validateOptions } from "../wasi/internal_wasi_options.ts";
import { createBashInstance } from "./BashInstance.ts";
import { rewindBash as rewind } from "./BashTransitions.ts";
import type { KernelBashCredentials, KernelBashProgramContext } from "./BashContext.ts";
import { bashImports } from "./BashImports.ts";
import { errno, range, resultErrno } from "./BashMemory.ts";
import type { BashProcess } from "./BashProcess.ts";
import { BashPreopens } from "./BashPreopens.ts";

const PAGE = 65_536;
const status = (exitCode: number, signal = 0): KernelExitStatus => ({
  exitCode,
  signal,
  coreDumped: false,
});

export async function runBashProgram(
  module: WebAssembly.Module,
  credentials: KernelBashCredentials,
  context: KernelBashProgramContext,
): Promise<KernelExitStatus> {
  return execute(module, createProcess(module, credentials, context));
}

function createProcess(
  module: WebAssembly.Module,
  credentials: KernelBashCredentials,
  context: KernelBashProgramContext,
  parentPreopens?: BashPreopens,
): BashProcess {
  const preopens = new BashPreopens(context.filesystem.descriptors, parentPreopens);
  const lifecycle = new WasiLifecycle(
    validateOptions({
      version: "preview1",
      args: [...context.args],
      env: { ...context.env },
      mounts: [],
      returnOnExit: true,
    }),
    true,
    {
      table: context.filesystem.descriptors,
      ownership: "borrowed",
      pathCheck: context.filesystem.assertWasiPathVisible.bind(context.filesystem),
      creation: {
        createInode: context.filesystem.createInode.bind(context.filesystem),
        takeCreateMode: context.filesystem.takeNextCreateMode.bind(context.filesystem),
      },
    },
    preopens.transformArguments,
    createKernelWasiFileSystemAdapter(context.filesystem, { process: context }),
  );
  // Imports close over this object; none can run until the instance has been bound.
  const process = {
    context,
    preopens,
    credentials: { ...credentials },
    lifecycle,
    stats: { mainHi: 0, captureBytesHi: 0, captureCompactions: 0, captureLiveHi: 0 },
    rewinding: false,
    resume: 0,
    pending: undefined,
  } as BashProcess;
  try {
    Object.assign(process, createBashInstance(module, bashImports(process)));
    lifecycle.finalizeBindings(process.instance);
    return process;
  } catch (error) {
    lifecycle.close();
    throw error;
  }
}

async function execute(
  module: WebAssembly.Module,
  process: BashProcess,
): Promise<KernelExitStatus> {
  const { context, exports: ex } = process;
  try {
    for (;;) {
      if (context.signal.aborted)
        throw Object.assign(new Error("Bash execution cancelled"), { code: "ECANCELED" });
      try {
        await process.lifecycle.runAsync(ex._start);
      } catch (error) {
        if (error instanceof WasiExit) return status(error.code);
        throw error;
      }
      const pending = process.pending;
      process.pending = undefined;
      if (pending === undefined) {
        if (process.rewinding)
          throw new Error("GNU Bash returned before landing its Asyncify continuation");
        return status(0);
      }
      ex.asyncify_stop_unwind();
      switch (pending.kind) {
        case "capture":
          rewind(
            process,
            process.captures.take(
              ex.memory,
              pending.env,
              pending.stack,
              process.stats,
              context.identity.pid,
            ),
          );
          break;
        case "longjmp": {
          const target = process.captures.jump(
            ex.memory,
            pending.env,
            pending.value,
            context.identity.pid,
          );
          ex.__stack_pointer.value = target.sp;
          rewind(process, target.at);
          break;
        }
        case "fork":
          process.resume = fork(module, process);
          rewind(process);
          break;
        case "wait": {
          const waited = await wait(process, pending.pid, pending.options);
          if (waited.status === "ok") {
            process.resume = waited.value.pid;
            if (pending.status !== 0 && "status" in waited.value) {
              const child = waited.value.status;
              const raw =
                child.signal === 0
                  ? (child.exitCode & 255) << 8
                  : (child.signal & 127) | (child.coreDumped ? 128 : 0);
              range(ex.memory, pending.status, 4);
              new DataView(ex.memory.buffer).setInt32(pending.status >>> 0, raw, true);
            }
          } else process.resume = -resultErrno(waited, "waitpid");
          rewind(process);
          break;
        }
        case "exec":
          try {
            return await context.exec({
              filesystem: context.filesystem,
              identity: context.identity,
              args: pending.args,
              env: pending.env,
              path: pending.path,
              signal: context.signal,
              ...(context.home === undefined ? {} : { home: context.home }),
            });
          } catch (error) {
            // A replacement that started owns this PID even if its execution later fails.
            if (!(error instanceof KernelProgramExecAdmissionError)) throw error;
            process.resume = -errno(error);
            rewind(process);
          }
      }
    }
  } catch (error) {
    return kernelProcessSignalExitStatus(error);
  } finally {
    await process.lifecycle.closeAsync();
  }
}

function fork(module: WebAssembly.Module, parent: BashProcess): number {
  const { context } = parent;
  const mapping = [...context.filesystem.descriptors.entries()].map(([fd]) => ({
    parentFd: fd,
    childFd: fd,
  }));
  const table = context.filesystem.descriptors.fork(mapping, { exec: false });
  let filesystem: typeof context.filesystem | undefined;
  try {
    filesystem = context.filesystem.fork(table);
  } catch (error) {
    void runAsync(table.closeAll());
    return -errno(error);
  }
  const childFilesystem = filesystem;
  const controller = new AbortController();
  let childCpu: KernelAsyncProgramCpu | undefined;
  let sentSignal = 0;
  const abort = () => controller.abort();
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) controller.abort();
  const spawned = context.processes.spawn(
    context.identity.handle,
    (identity) => {
      childCpu = context.cpu?.forProcess(identity.pid);
      const launch = () => {
        const child = createProcess(
          module,
          parent.credentials,
          {
            ...context,
            filesystem: childFilesystem,
            identity,
            signal: controller.signal,
            ...(childCpu === undefined ? {} : { cpu: childCpu }),
          },
          parent.preopens,
        );
        const source = parent.exports.memory;
        const target = child.exports.memory;
        if (target.buffer.byteLength < source.buffer.byteLength)
          target.grow((source.buffer.byteLength - target.buffer.byteLength) / PAGE);
        new Uint8Array(target.buffer).set(new Uint8Array(source.buffer));
        child.exports.__stack_pointer.value = parent.exports.__stack_pointer.value;
        child.captures = parent.captures.fork();
        child.resume = 0;
        rewind(child);
        const completion = Promise.resolve()
          .then(() => runKernelExecution(controller.signal, () => execute(module, child)))
          .then(
            (value) =>
              controller.signal.aborted && sentSignal !== 0 ? status(0, sentSignal) : value,
            (error: unknown) => {
              if (controller.signal.aborted && sentSignal !== 0) return status(0, sentSignal);
              throw error;
            },
          );
        return {
          completion,
          supportedSignals: [9, 15],
          signal: (signal: number) => {
            if (signal !== 9 && signal !== 15)
              return kernelError("UNSUPPORTED", "Bash signal handlers are unavailable");
            sentSignal = signal;
            controller.abort();
            return kernelOk(undefined);
          },
        };
      };
      return childCpu === undefined ? launch() : childCpu.run(launch);
    },
    async () => {
      context.signal.removeEventListener("abort", abort);
      const release = async () => {
        try {
          await runAsync(table.closeAll());
        } finally {
          childFilesystem.dispose();
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
  return spawned.status === "ok" ? spawned.value.pid : -resultErrno(spawned, "fork");
}

async function wait(process: BashProcess, pid: number, options: number) {
  const { context } = process;
  for (;;) {
    const result = context.processes.waitpid(context.identity.handle, pid, options);
    if (result.status !== "would_block") return result;
    try {
      const woke = await context.wakes.wait(result.wakeToken, context.signal);
      if (woke.status !== "ok") return kernelError("CANCELLED", woke.error.message);
    } finally {
      context.wakes.release(result.wakeToken);
    }
  }
}
