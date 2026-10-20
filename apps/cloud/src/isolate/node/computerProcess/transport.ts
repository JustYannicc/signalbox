import type { ComputerExecPort } from "../../../computer/Computer.ts";
import { kernelError, kernelOk, type KernelHandle } from "../../../kernel/KernelAbi.ts";
import type { KernelCommandChild } from "../../../kernel/KernelCommandForwarder.ts";
import type {
  KernelProgramHost,
  KernelPreparedProgram,
} from "../../../kernel/KernelProgramHost.ts";
import type { KernelExitStatus } from "../../../kernel/KernelProcessTable.ts";
import type { NodeChildProcessTransport } from "../childProcess/ChildProcess.ts";
import type { NormalizedSpawn } from "../childProcess/arguments.ts";
import { abortError, unwrapHostResult } from "../childProcess/errors.ts";
import { createKernelProcessStreams } from "../../../kernel/KernelProcessStreams.ts";
import { withAbort } from "./streams.ts";

export function createComputerProcessTransport(
  host: KernelProgramHost,
  computer: ComputerExecPort,
): NodeChildProcessTransport {
  const completions = new WeakMap<
    KernelHandle<"process">,
    {
      completion: Promise<KernelExitStatus>;
      cleaned: Promise<void>;
    }
  >();
  return {
    async exitStatus(handle) {
      const pending = completions.get(handle);
      if (pending) await pending.cleaned;
      const result = await host.exitStatus(handle);
      if (pending) await pending.completion;
      return result;
    },
    spawn(prepared, spawn) {
      const controller = new AbortController();
      let child: KernelCommandChild | undefined;
      let sentSignal = 0;
      let signalDone = Promise.resolve();
      const queuedSignals: number[] = [];
      const forwardSignal = (target: KernelCommandChild, number: number) => {
        signalDone = signalDone.then(async () => {
          unwrapHostResult(await target.signal(number), "signal");
        });
        void signalDone.catch(() => undefined);
      };
      let markCleaned!: () => void;
      const cleaned = new Promise<void>((resolve) => {
        markCleaned = resolve;
      });
      const abort = () => controller.abort(prepared.signal?.reason ?? abortError());
      const result = host.processes.spawn(
        prepared.parent,
        (identity) => {
          prepared.transfer();
          prepared.signal?.addEventListener("abort", abort, { once: true });
          if (prepared.signal?.aborted) abort();
          const completion = runComputerCommand(computer, prepared, spawn, {
            signal: controller.signal,
            admitted(value) {
              child = value;
              for (const number of queuedSignals) forwardSignal(value, number);
              queuedSignals.length = 0;
            },
            cancelledStatus() {
              if (sentSignal !== 0) return { exitCode: 0, signal: sentSignal, coreDumped: false };
              throw abortError();
            },
            signalsSettled: () => signalDone,
          });
          completions.set(identity.handle, { completion, cleaned });
          return {
            completion,
            signal(number) {
              if (number === 0) return kernelOk(undefined);
              if (number !== 9 && number !== 15) {
                return kernelError("UNSUPPORTED", "Only terminate and kill are supported");
              }
              sentSignal = number;
              if (child === undefined) queuedSignals.push(number);
              else forwardSignal(child, number);
              controller.abort(abortError());
              return kernelOk(undefined);
            },
          };
        },
        async () => {
          prepared.signal?.removeEventListener("abort", abort);
          try {
            await signalDone;
          } finally {
            try {
              if (prepared.canTransfer) await prepared.release();
              else await prepared.releaseTransferred();
            } finally {
              markCleaned();
            }
          }
        },
      );
      return result.status === "ok" ? kernelOk(result.value.handle) : result;
    },
  };
}

async function runComputerCommand(
  computer: ComputerExecPort,
  prepared: KernelPreparedProgram,
  spawn: NormalizedSpawn,
  lifecycle: {
    readonly signal: AbortSignal;
    readonly admitted: (child: KernelCommandChild) => void;
    readonly cancelledStatus: () => KernelExitStatus;
    readonly signalsSettled: () => Promise<void>;
  },
) {
  let child: KernelCommandChild;
  try {
    child = await computer.exec(
      {
        executable: spawn.executable,
        argv: spawn.argv,
        cwd: prepared.filesystem.cwd,
        env: spawn.env,
      },
      lifecycle.signal,
    );
  } catch (error) {
    if (lifecycle.signal.aborted) return lifecycle.cancelledStatus();
    throw error;
  }
  void child.exited.catch(() => undefined);
  lifecycle.admitted(child);
  const input = new AbortController();
  const output = new AbortController();
  const stop = () => {
    input.abort();
    output.abort();
  };
  lifecycle.signal.addEventListener("abort", stop, { once: true });
  let pumps: Promise<void>[] = [];
  try {
    if (lifecycle.signal.aborted) return lifecycle.cancelledStatus();
    const stdin = createKernelProcessStreams(prepared.filesystem, { signal: input.signal }).stdin;
    const streams = createKernelProcessStreams(prepared.filesystem, { signal: output.signal });
    pumps = [
      stdin.pipeTo(child.stdin, { signal: input.signal }),
      child.stdout.pipeTo(streams.stdout, { signal: output.signal }),
      child.stderr.pipeTo(streams.stderr, { signal: output.signal }),
    ];
    const failed = new Promise<never>((_, reject) => {
      for (const pump of pumps)
        void pump.catch((error: unknown) => {
          if (!input.signal.aborted && !output.signal.aborted) reject(error);
        });
    });
    const status = await withAbort(Promise.race([child.exited, failed]), lifecycle.signal);
    input.abort();
    await Promise.all(pumps.slice(1));
    return status;
  } catch (error) {
    if (lifecycle.signal.aborted) return lifecycle.cancelledStatus();
    throw error;
  } finally {
    lifecycle.signal.removeEventListener("abort", stop);
    stop();
    try {
      await lifecycle.signalsSettled();
    } finally {
      await Promise.allSettled(pumps);
      await child.dispose();
    }
  }
}
