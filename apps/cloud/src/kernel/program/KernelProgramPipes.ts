import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { KernelPipe } from "../KernelPipe.ts";
import { currentKernelIoMode, currentKernelSignal } from "../process/KernelExecution.ts";
import {
  RIGHTS,
  type WasiDescriptorSpec,
  type WasiStdio,
} from "../wasi/internal_wasi_descriptors.ts";
import type {
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

function readEndpoint(
  pipe: KernelPipe,
  wakes: KernelWakeRegistry,
  signal?: AbortSignal,
): PollableStdio {
  return {
    readInto: (target) =>
      currentKernelIoMode() === "sync"
        ? pipe.tryReadInto(target)
        : pipe.readInto(target, { signal: currentKernelSignal() ?? signal }),
    poll: (direction, requestedSignal) =>
      pollPipe(pipe, wakes, direction, requestedSignal ?? currentKernelSignal() ?? signal),
  };
}

function writeEndpoint(pipe: KernelPipe, wakes: KernelWakeRegistry): PollableStdio {
  return {
    write: (source) =>
      currentKernelIoMode() === "sync"
        ? pipe.tryWrite(source)
        : pipe.write(source, { signal: currentKernelSignal() }),
    poll: (direction, signal) => pollPipe(pipe, wakes, direction, signal ?? currentKernelSignal()),
  };
}

function readable(pipe: KernelPipe, signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const target = new Uint8Array(READ_CHUNK_BYTES);
      try {
        const count = await pipe.readInto(target, { signal });
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
  const registration = wakes.register(pipe.subscribe(direction));
  if (registration.status !== "ok") {
    throw Object.assign(new Error(registration.error.message), { code: "ECANCELED" });
  }
  const token = registration.value;
  try {
    if (pipe.ready(direction)) wakes.signal(token);
    const result = await wakes.wait(token, signal);
    if (result.status !== "ok") {
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code === "EXPIRED" ? "ETIMEDOUT" : "ECANCELED",
      });
    }
  } finally {
    wakes.release(token);
  }
}
