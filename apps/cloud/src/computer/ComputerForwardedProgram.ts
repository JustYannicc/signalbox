import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandForwarder,
} from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import { createKernelProcessStreams } from "../kernel/KernelProcessStreams.ts";
import { KernelProcessSignal } from "../kernel/KernelProcessSignal.ts";
import type { KernelProgramAdmissionRequest } from "../kernel/KernelProgramAdmission.ts";
import { KernelOpenFlags } from "../kernel/KernelFileSystem.ts";

/** Preview descriptor shape without opening, truncating or closing the guest's files. */
export function assertComputerForwardingSupported(request: KernelProgramAdmissionRequest): void {
  const attributes = request.attributes;
  if (
    attributes !== undefined &&
    ((attributes.flags & 2) !== 0 ||
      attributes.processGroup !== 0 ||
      attributes.defaultMask.low !== 0 ||
      attributes.defaultMask.high !== 0 ||
      attributes.signalMask.low !== 0 ||
      attributes.signalMask.high !== 0)
  ) {
    throw new KernelProgramExecAdmissionError(
      "ENOTSUP",
      "Machine process attributes are unavailable",
    );
  }
  const handle = request.kind === "exec" ? request.identity?.handle : request.parent;
  if (request.kind === "exec" && handle === undefined) {
    throw new KernelProgramExecAdmissionError("EINVAL", "Machine exec process is missing");
  }
  const process = request.processes.info(handle);
  const root = request.processes.info();
  if (process.status !== "ok" || root.status !== "ok") {
    throw new KernelProgramExecAdmissionError("ESRCH", "Machine process state is unavailable");
  }
  // Ordinary descendants inherit the root group, rather than using their own PID.
  if (process.value.processGroupId !== root.value.processGroupId) {
    throw new KernelProgramExecAdmissionError("ENOTSUP", "Machine process groups are unavailable");
  }
  if (request.kind !== "spawn") {
    const mask = request.processes.signalMask(handle, 3);
    if (mask.status !== "ok") {
      throw new KernelProgramExecAdmissionError("ESRCH", "Machine signal mask is unavailable");
    }
    if (mask.value.low !== 0 || mask.value.high !== 0) {
      throw new KernelProgramExecAdmissionError("ENOTSUP", "Machine signal masks are unavailable");
    }
  }
  const descriptors = new Map(
    Array.from(request.filesystem.descriptors.entries())
      .filter(
        ([fd, descriptor]) => request.kind !== "command" || fd <= 2 || descriptor.preopen === true,
      )
      .map(
        ([fd, descriptor]) =>
          [
            fd,
            { preopen: descriptor.preopen === true, closeOnExec: descriptor.closeOnExec },
          ] as const,
      ),
  );
  if (request.kind === "command") {
    for (const fd of [0, 1, 2]) {
      descriptors.set(fd, { preopen: false, closeOnExec: false });
    }
  }
  for (const action of request.actions) {
    switch (action.kind) {
      case "close":
        descriptors.delete(action.fd);
        break;
      case "closefrom":
        for (const fd of descriptors.keys()) if (fd >= action.fd) descriptors.delete(fd);
        break;
      case "open":
        descriptors.set(action.fd, {
          preopen: false,
          closeOnExec: (action.flags & KernelOpenFlags.O_CLOEXEC) !== 0,
        });
        break;
      case "dup2": {
        const source = descriptors.get(action.sourceFd);
        if (source === undefined) {
          throw new KernelProgramExecAdmissionError("EBADF", "Spawn descriptor source is missing");
        }
        descriptors.set(action.fd, { preopen: false, closeOnExec: false });
        break;
      }
    }
  }
  for (const [fd, descriptor] of descriptors) {
    if (descriptor.closeOnExec) descriptors.delete(fd);
    else if (fd > 2 && !descriptor.preopen) {
      throw new KernelProgramExecAdmissionError(
        "ENOTSUP",
        "Machine cannot inherit extra descriptors",
      );
    }
  }
  if (![0, 1, 2].every((fd) => descriptors.has(fd))) {
    throw new KernelProgramExecAdmissionError(
      "ENOTSUP",
      "Machine requires open standard descriptors",
    );
  }
}

/** The machine port must settle its revision bracket into this process's backing filesystem. */
export function createComputerForwardedProgram(
  machine: KernelCommandForwarder,
  command: KernelCommand,
): Extract<KernelProgramImplementation, { readonly kind: "async" }> {
  const captured = Object.freeze({
    executable: command.executable,
    argv: Object.freeze([...command.argv]),
    env: Object.freeze({ ...command.env }),
  });
  return Object.freeze({
    kind: "async" as const,
    async run(context: KernelAsyncProgramContext) {
      context.signal.throwIfAborted();
      if (!sameArguments(captured.argv, context.args)) {
        throw new Error("Forwarded program arguments changed after admission");
      }
      if (!sameEnvironment(captured.env, context.env)) {
        throw new Error("Forwarded program environment changed after admission");
      }
      assertForwardableDescriptors(context);
      const child = await machine.spawn(
        Object.freeze({
          executable: captured.executable,
          argv: captured.argv,
          cwd: context.filesystem.cwd,
          env: captured.env,
        }),
        context.signal,
      );
      return pumpForwardedProgram(context, child);
    },
  });
}

function sameArguments(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameEnvironment(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function assertForwardableDescriptors(context: KernelAsyncProgramContext) {
  for (const [fd, descriptor] of context.filesystem.descriptors.entries()) {
    if (fd > 2 && !descriptor.preopen) {
      throw Object.assign(new Error("Machine forwarding cannot carry extra process descriptors"), {
        code: "ENOTSUP",
      });
    }
  }
}

async function pumpForwardedProgram(context: KernelAsyncProgramContext, child: KernelCommandChild) {
  void child.exited.catch(() => undefined);
  const input = new AbortController();
  const output = new AbortController();
  const cancellation = Promise.withResolvers<never>();
  void cancellation.promise.catch(() => undefined);
  let signalSent: Promise<void> | undefined;
  const stop = () => {
    const reason: unknown = context.signal.reason;
    if (reason instanceof KernelProcessSignal) {
      signalSent ??= Promise.resolve()
        .then(() => child.signal(reason.signal))
        .then((result) => {
          if (result.status !== "ok") throw new Error("Forwarded process refused its signal");
        });
      void signalSent.catch(() => undefined);
    }
    input.abort(reason);
    output.abort(reason);
    cancellation.reject(reason);
  };
  context.signal.addEventListener("abort", stop, { once: true });
  if (context.signal.aborted) stop();
  let pumps: Promise<void>[] = [];
  try {
    context.signal.throwIfAborted();
    const stdin = createKernelProcessStreams(context.filesystem, { signal: input.signal }).stdin;
    const streams = createKernelProcessStreams(context.filesystem, { signal: output.signal });
    pumps = [
      // The descriptor signal owns cancellation; Workerd drops a second cancel's rejection.
      stdin.pipeTo(child.stdin, { signal: input.signal, preventCancel: true }),
      child.stdout.pipeTo(streams.stdout, { signal: output.signal }),
      child.stderr.pipeTo(streams.stderr, { signal: output.signal }),
    ];
    const failed = Promise.withResolvers<never>();
    for (const pump of pumps) {
      void pump.catch((error: unknown) => {
        if (!input.signal.aborted && !output.signal.aborted) failed.reject(error);
      });
    }
    const status = await Promise.race([child.exited, failed.promise, cancellation.promise]);
    input.abort();
    await Promise.all(pumps.slice(1));
    return status;
  } finally {
    context.signal.removeEventListener("abort", stop);
    input.abort();
    output.abort();
    try {
      await signalSent;
    } finally {
      await Promise.allSettled(pumps);
      await child.dispose();
    }
  }
}
