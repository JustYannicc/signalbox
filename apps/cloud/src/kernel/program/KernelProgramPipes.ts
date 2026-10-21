import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { KernelPipe } from "../KernelPipe.ts";
import { currentKernelIoMode, currentKernelSignal } from "../process/KernelExecution.ts";
import type { AgentOsSpawnFileAction } from "../process/AgentOsProcessActions.ts";
import { KernelOpenFlags } from "../filesystem/KernelOpenFlags.ts";
import {
  RIGHTS,
  FDFLAGS,
  type WasiDescriptorSpec,
  type WasiStdio,
} from "../wasi/internal_wasi_descriptors.ts";
import type {
  KernelOwnedStdio,
  KernelPreparedProgram,
  KernelProgramPrepareInput,
  KernelProgramPrepareOptions,
} from "./KernelPreparedProgram.ts";
import { prepareKernelProgram } from "./KernelPreparedProgram.ts";

const PIPE_CAPACITY_BYTES = 65_536;
const READ_CHUNK_BYTES = 16_384;

export interface KernelPipedProgram {
  readonly prepared: KernelPreparedProgram;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export type KernelNodeChildStdioMode = "pipe" | "ignore" | number;
export type KernelNodeChildStdio = readonly [
  KernelNodeChildStdioMode,
  KernelNodeChildStdioMode,
  KernelNodeChildStdioMode,
];

export interface KernelNodeChildStdioProgram {
  readonly prepared: KernelPreparedProgram;
  readonly stdin: WritableStream<Uint8Array> | undefined;
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly stderr: ReadableStream<Uint8Array> | undefined;
}

interface PollResult {
  readonly bytes: bigint;
  readonly hangup?: boolean;
}
type PollDirection = "read" | "write";
type PollableStdio = WasiStdio & {
  poll: (direction: PollDirection, signal?: AbortSignal) => PollResult | Promise<PollResult>;
};

export function preparePipedKernelProgram(
  wakes: KernelWakeRegistry,
  input: KernelProgramPrepareInput,
  options: KernelProgramPrepareOptions = {},
): KernelPipedProgram {
  const stdinPipe = new KernelPipe(wakes, PIPE_CAPACITY_BYTES);
  const stdoutPipe = new KernelPipe(wakes, PIPE_CAPACITY_BYTES);
  const stderrPipe = new KernelPipe(wakes, PIPE_CAPACITY_BYTES);
  const stdin = new WritableStream<Uint8Array>({
    write: (chunk) => writeAll(stdinPipe, chunk, input.signal),
    close: () => stdinPipe.closeWriter(),
    abort: () => stdinPipe.closeWriter(),
  });
  const stdout = readable(stdoutPipe, input.signal);
  const stderr = readable(stderrPipe, input.signal);

  const ownedStdio = {
    descriptors: [
      pipeDescriptor(readEndpoint(stdinPipe, wakes, input.signal), RIGHTS.FD_READ, () =>
        stdinPipe.closeReader(),
      ),
      pipeDescriptor(writeEndpoint(stdoutPipe, wakes), RIGHTS.FD_WRITE, () =>
        stdoutPipe.closeWriter(),
      ),
      pipeDescriptor(writeEndpoint(stderrPipe, wakes), RIGHTS.FD_WRITE, () =>
        stderrPipe.closeWriter(),
      ),
    ] as const,
    releaseBeforeTransfer: () => {
      stdinPipe.closeReader();
      stdinPipe.closeWriter();
      stdoutPipe.closeWriter();
      stderrPipe.closeWriter();
    },
  };

  try {
    const prepared = prepareKernelProgram(input, options, ownedStdio);
    return { prepared, stdin, stdout, stderr };
  } catch (error) {
    ownedStdio.releaseBeforeTransfer();
    stdoutPipe.closeReader();
    stderrPipe.closeReader();
    throw error;
  }
}

export function prepareNodeChildStdioKernelProgram(
  wakes: KernelWakeRegistry,
  input: KernelProgramPrepareInput,
  options: Pick<KernelProgramPrepareOptions, "cwd">,
  stdio: KernelNodeChildStdio,
  borrowedStdio?: NonNullable<KernelProgramPrepareOptions["stdio"]>,
): KernelNodeChildStdioProgram {
  if (borrowedStdio !== undefined) {
    for (const [fd, mode] of stdio.entries()) {
      if ((mode === "pipe") !== (borrowedStdio[fd] !== undefined)) {
        throw new TypeError("Borrowed child stdio must be supplied for pipe slots only");
      }
    }
  }

  const createPipe = (mode: KernelNodeChildStdioMode) =>
    mode === "pipe" && borrowedStdio === undefined
      ? new KernelPipe(wakes, PIPE_CAPACITY_BYTES)
      : undefined;
  const pipes: readonly [KernelPipe | undefined, KernelPipe | undefined, KernelPipe | undefined] = [
    createPipe(stdio[0]),
    createPipe(stdio[1]),
    createPipe(stdio[2]),
  ];
  const stdin = pipes[0] === undefined ? undefined : writable(pipes[0], input.signal);
  const stdout = pipes[1] === undefined ? undefined : readable(pipes[1], input.signal);
  const stderr = pipes[2] === undefined ? undefined : readable(pipes[2], input.signal);
  const descriptorFor = (fd: 0 | 1 | 2): WasiDescriptorSpec | undefined => {
    const pipe = pipes[fd];
    if (pipe === undefined) return undefined;
    if (fd === 0) {
      return pipeDescriptor(readEndpoint(pipe, wakes, input.signal), RIGHTS.FD_READ, () =>
        pipe.closeReader(),
      );
    }
    return pipeDescriptor(writeEndpoint(pipe, wakes), RIGHTS.FD_WRITE, () => pipe.closeWriter());
  };
  const descriptors: KernelOwnedStdio["descriptors"] = [
    descriptorFor(0),
    descriptorFor(1),
    descriptorFor(2),
  ];
  const ownedStdio: KernelOwnedStdio = {
    descriptors,
    prepareActions(filesystem) {
      const sourceAliases = new Map<number, number>();
      // Alias allocation can reuse a closed numeric source, so validate the fork first.
      for (const mode of stdio) {
        if (typeof mode === "number") filesystem.descriptors.get(mode);
      }
      // Pipe slots replace standard descriptors before the file actions use numeric sources.
      for (const mode of stdio) {
        if (typeof mode === "number" && mode <= 2 && !sourceAliases.has(mode)) {
          sourceAliases.set(mode, filesystem.descriptors.duplicate(mode, { closeOnExec: true }));
        }
      }

      return stdio.flatMap((mode, fd): AgentOsSpawnFileAction[] => {
        if (mode === "ignore") {
          return [
            {
              kind: "open",
              fd,
              sourceFd: 0,
              flags: fd === 0 ? KernelOpenFlags.O_RDONLY : KernelOpenFlags.O_WRONLY,
              mode: 0,
              path: "/dev/null",
            },
          ];
        }
        if (typeof mode === "number") {
          return [
            {
              kind: "dup2",
              fd,
              sourceFd: sourceAliases.get(mode) ?? mode,
              flags: 0,
              mode: 0,
            },
          ];
        }
        return [];
      });
    },
    releaseBeforeTransfer() {
      for (const pipe of pipes) {
        pipe?.closeReader();
        pipe?.closeWriter();
      }
    },
  };

  try {
    const prepared = prepareKernelProgram(
      input,
      { ...options, ...(borrowedStdio === undefined ? {} : { stdio: borrowedStdio }) },
      ownedStdio,
    );
    return { prepared, stdin, stdout, stderr };
  } catch (error) {
    ownedStdio.releaseBeforeTransfer?.();
    pipes[1]?.closeReader();
    pipes[2]?.closeReader();
    throw error;
  }
}

function pipeDescriptor(
  stdio: PollableStdio,
  accessRight: bigint,
  onLastClose: NonNullable<WasiDescriptorSpec["onLastClose"]>,
): WasiDescriptorSpec {
  return {
    kind: "stdio",
    stdio,
    offset: 0n,
    rightsBase: accessRight | RIGHTS.FD_FDSTAT_SET_FLAGS | RIGHTS.POLL_FD_READWRITE,
    rightsInheriting: 0n,
    flags: 0,
    onLastClose,
  };
}

export function readEndpoint(
  pipe: KernelPipe,
  wakes: KernelWakeRegistry,
  signal?: AbortSignal,
): PollableStdio {
  return {
    supportsNonblocking: true,
    readInto: (target, flags) =>
      (flags & FDFLAGS.NONBLOCK) !== 0 || currentKernelIoMode() === "sync"
        ? pipe.tryReadInto(target)
        : pipe.readInto(target, { signal: currentKernelSignal() ?? signal }),
    poll: (direction, requestedSignal) =>
      pollPipe(pipe, wakes, direction, requestedSignal ?? currentKernelSignal() ?? signal),
  };
}

export function writeEndpoint(pipe: KernelPipe, wakes: KernelWakeRegistry): PollableStdio {
  return {
    supportsNonblocking: true,
    write: (source, flags) =>
      (flags & FDFLAGS.NONBLOCK) !== 0 || currentKernelIoMode() === "sync"
        ? pipe.tryWrite(source)
        : pipe.write(source, { signal: currentKernelSignal() }),
    poll: (direction, signal) => pollPipe(pipe, wakes, direction, signal ?? currentKernelSignal()),
  };
}

export function writable(
  pipe: KernelPipe,
  signal?: AbortSignal,
  pending?: Set<Promise<unknown>>,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write: (chunk) => trackPipeIo(writeAll(pipe, chunk, signal), pending),
    close: () => pipe.closeWriter(),
    abort: () => pipe.closeWriter(),
  });
}

export function readable(
  pipe: KernelPipe,
  signal?: AbortSignal,
  pending?: Set<Promise<unknown>>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const target = new Uint8Array(READ_CHUNK_BYTES);
      try {
        const count = await trackPipeIo(pipe.readInto(target, { signal }), pending);
        if (count === 0) {
          pipe.closeReader();
          controller.close();
        } else {
          controller.enqueue(target.slice(0, count));
        }
      } catch (error) {
        controller.error(error);
        pipe.closeReader();
      }
    },
    cancel() {
      pipe.closeReader();
    },
  });
}

async function writeAll(pipe: KernelPipe, chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
  const owned = new Uint8Array(chunk);
  let offset = 0;
  while (offset < owned.byteLength) {
    const written = await pipe.write(owned.subarray(offset), { signal });
    offset += written;
  }
}

function pollPipe(
  pipe: KernelPipe,
  wakes: KernelWakeRegistry,
  direction: PollDirection,
  signal?: AbortSignal,
): Promise<PollResult> | PollResult {
  if (signal?.aborted) throw Object.assign(new Error("Pipe poll cancelled"), { code: "ECANCELED" });
  if (!pipe.ready(direction)) {
    return waitForReadiness(pipe, wakes, direction, signal).then(() =>
      pollPipe(pipe, wakes, direction, signal),
    );
  }
  return pipeReadiness(pipe, direction);
}

function pipeReadiness(pipe: KernelPipe, direction: PollDirection): PollResult {
  const buffered = pipe.bufferedBytes;
  const bytes = direction === "read" ? buffered : PIPE_CAPACITY_BYTES - buffered;
  const hangup = direction === "read" && buffered === 0;
  return hangup ? { bytes: BigInt(bytes), hangup: true } : { bytes: BigInt(bytes) };
}

async function waitForReadiness(
  pipe: KernelPipe,
  wakes: KernelWakeRegistry,
  direction: PollDirection,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal?.aborted)
      throw Object.assign(new Error("Pipe poll cancelled"), { code: "ECANCELED" });
    const registration = wakes.register(pipe.subscribe(direction));
    if (registration.status !== "ok") {
      throw Object.assign(new Error(registration.error.message), { code: "ECANCELED" });
    }
    const token = registration.value;
    try {
      if (pipe.ready(direction)) wakes.signal(token);
      const result = await wakes.wait(token, signal);
      if (result.status === "ok") return;
      // Recheck readiness under a fresh subscription after its notification expires.
      if (result.error.code === "EXPIRED") continue;
      throw Object.assign(new Error(result.error.message), { code: "ECANCELED" });
    } finally {
      wakes.release(token);
    }
  }
}

export function trackPipeIo<T>(operation: Promise<T>, pending?: Set<Promise<unknown>>): Promise<T> {
  if (pending === undefined) return operation;
  const tracked = operation.finally(() => pending.delete(tracked));
  pending.add(tracked);
  return tracked;
}
