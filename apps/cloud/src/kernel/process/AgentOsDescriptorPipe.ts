import { FDFLAGS, RIGHTS, type WasiDescriptorSpec } from "../wasi/internal_wasi_descriptors.ts";
import type { WasiStdio } from "../wasi/internal_wasi_fs.ts";
import { KernelPipe } from "../KernelPipe.ts";
import { mapErrno, runSync } from "../wasi/internal_wasi_calls.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import type { AgentOsDescriptorHostOptions } from "./AgentOsDescriptorSupport.ts";
import { validRange, writeU32 } from "./AgentOsDescriptorSupport.ts";

const EFAULT = 21;
const EIO = 29;
const PIPE_CAPACITY_BYTES = 65_536;

type PipeDirection = "read" | "write";
interface PipePollResult {
  readonly bytes: bigint;
  readonly hangup?: boolean;
}
interface PollableStdio extends WasiStdio {
  poll: (
    direction: PipeDirection,
    signal?: AbortSignal,
  ) => PipePollResult | Promise<PipePollResult>;
}

export function allocateAgentOsPipe(
  options: AgentOsDescriptorHostOptions,
  readPointer: number,
  writePointer: number,
): number {
  const memory = options.memory();
  if (!validRange(memory, readPointer, 4) || !validRange(memory, writePointer, 4)) return EFAULT;

  const pipe = new KernelPipe(options.wakes, PIPE_CAPACITY_BYTES);
  const readEnd: PollableStdio = {
    supportsNonblocking: true,
    readInto: (target, flags) =>
      options.asyncMode && (flags & FDFLAGS.NONBLOCK) === 0
        ? pipe.readInto(target, {
            signal: options.currentSignal?.(),
          })
        : pipe.tryReadInto(target),
    poll: (direction, signal) => {
      const currentSignal = options.currentSignal?.();
      return pollPipe(pipe, options.wakes, direction, signal ?? currentSignal);
    },
  };
  const writeEnd: PollableStdio = {
    supportsNonblocking: true,
    write: (source, flags) =>
      options.asyncMode && (flags & FDFLAGS.NONBLOCK) === 0
        ? pipe.writeBlocking(source, {
            signal: options.currentSignal?.(),
          })
        : pipe.tryWrite(source),
    poll: (direction, signal) => {
      const currentSignal = options.currentSignal?.();
      return pollPipe(pipe, options.wakes, direction, signal ?? currentSignal);
    },
  };

  let readFd: number | undefined;
  let writeFd: number | undefined;
  try {
    readFd = options.descriptors.allocate(
      pipeDescriptor(readEnd, RIGHTS.FD_READ, () => pipe.closeReader()),
    );
    writeFd = options.descriptors.allocate(
      pipeDescriptor(writeEnd, RIGHTS.FD_WRITE, () => pipe.closeWriter()),
    );
  } catch (error) {
    pipe.closeReader();
    pipe.closeWriter();
    for (const fd of [readFd, writeFd]) {
      if (fd === undefined) continue;
      try {
        runSync(options.descriptors.close(fd));
      } catch {
        // Preserve the allocation errno after closing the partial pipe.
      }
    }
    return toErrno(error);
  }

  writeU32(memory, readPointer, readFd);
  writeU32(memory, writePointer, writeFd);
  return 0;
}

function pipeDescriptor(
  stdio: WasiStdio,
  ioRight: bigint,
  onLastClose: NonNullable<WasiDescriptorSpec["onLastClose"]>,
): WasiDescriptorSpec {
  return {
    kind: "stdio",
    stdio,
    offset: 0n,
    rightsBase: ioRight | RIGHTS.POLL_FD_READWRITE | RIGHTS.FD_FDSTAT_SET_FLAGS,
    rightsInheriting: 0n,
    flags: 0,
    onLastClose,
  };
}

function pollPipe(
  pipe: KernelPipe,
  wakes: KernelWakeRegistry,
  direction: PipeDirection,
  signal: AbortSignal | undefined,
): PipePollResult | Promise<PipePollResult> {
  if (signal?.aborted) throw pipeError("ECANCELED", "Pipe poll cancelled");
  if (pipe.ready(direction)) return pollResult(pipe, direction);
  return waitForPipeReadiness(pipe, wakes, direction, signal).then(() => {
    return pollPipe(pipe, wakes, direction, signal);
  });
}

async function waitForPipeReadiness(
  pipe: KernelPipe,
  wakes: KernelWakeRegistry,
  direction: PipeDirection,
  signal: AbortSignal | undefined,
): Promise<void> {
  const registered = wakes.register(pipe.subscribe(direction));
  if (registered.status !== "ok") {
    throw pipeError(
      registered.error.code === "RESOURCE_LIMIT" ? "ENOMEM" : "ECANCELED",
      registered.error.message,
    );
  }

  const token = registered.value;
  try {
    if (pipe.ready(direction)) wakes.signal(token);
    const result = await wakes.wait(token, signal);
    if (result.status !== "ok") {
      throw pipeError(
        result.error.code === "EXPIRED" ? "ETIMEDOUT" : "ECANCELED",
        result.error.message,
      );
    }
  } finally {
    wakes.release(token);
  }
}

function pollResult(pipe: KernelPipe, direction: PipeDirection): PipePollResult {
  const buffered = pipe.bufferedBytes;
  const bytes = direction === "read" ? buffered : PIPE_CAPACITY_BYTES - buffered;
  const hangup = direction === "read" && buffered === 0 && pipe.ready(direction);
  return hangup ? { bytes: BigInt(bytes), hangup: true } : { bytes: BigInt(bytes) };
}

function pipeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toErrno(error: unknown): number {
  try {
    return mapErrno(error);
  } catch {
    return EIO;
  }
}
