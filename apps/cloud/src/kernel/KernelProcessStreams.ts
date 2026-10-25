import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { FDFLAGS, RIGHTS } from "./wasi/internal_wasi_descriptors.ts";
import { runKernelExecution } from "./process/KernelExecution.ts";

const CHUNK_BYTES = 16_384;

/** Stream cancellation stops I/O without closing the borrowed process descriptors. */
export function createKernelProcessStreams(
  filesystem: KernelFileSystem,
  options: { readonly signal?: AbortSignal } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  return {
    stdin: descriptorInput(filesystem, signal),
    stdout: descriptorOutput(filesystem, 1, signal),
    stderr: descriptorOutput(filesystem, 2, signal),
  };
}

function descriptorInput(filesystem: KernelFileSystem, signal: AbortSignal) {
  const controller = new AbortController();
  const ioSignal = AbortSignal.any([signal, controller.signal]);
  let pending: Promise<void> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        pending = (async () => {
          const buffer = new Uint8Array(CHUNK_BYTES);
          const count = await descriptorIo(filesystem, 0, buffer, "read", ioSignal);
          if (count === 0) stream.close();
          else stream.enqueue(buffer.subarray(0, count));
        })();
        return pending;
      },
      async cancel(reason) {
        controller.abort(reason);
        try {
          await pending;
        } catch {
          // The read error belongs to the cancelled stream's pending pull.
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function descriptorOutput(filesystem: KernelFileSystem, fd: 1 | 2, signal: AbortSignal) {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const count = await descriptorIo(filesystem, fd, chunk.subarray(offset), "write", signal);
        if (count === 0) throw new Error("Command output made no progress");
        offset += count;
      }
    },
  });
}

async function descriptorIo(
  filesystem: KernelFileSystem,
  fd: number,
  buffer: Uint8Array,
  direction: "read" | "write",
  signal: AbortSignal,
): Promise<number> {
  const descriptor = filesystem.descriptors.get(fd);
  const right = direction === "read" ? RIGHTS.FD_READ : RIGHTS.FD_WRITE;
  if ((descriptor.rightsBase & right) !== right) {
    throw Object.assign(new Error("Descriptor does not permit command I/O"), { code: "EBADF" });
  }
  const stream = descriptor.kind === "stdio" ? descriptor.stdio : undefined;
  if (stream === undefined) {
    signal.throwIfAborted();
    return direction === "read"
      ? filesystem.read(fd, buffer, null)
      : filesystem.write(fd, buffer, null);
  }
  // Nonblocking attempts plus the descriptor's poll use the same kernel wake registry.
  const flags = stream.supportsNonblocking ? descriptor.flags | FDFLAGS.NONBLOCK : descriptor.flags;
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = runKernelExecution(signal, () =>
        direction === "read"
          ? (stream.readInto?.(buffer, flags) ?? 0)
          : stream.write?.(buffer, flags),
      );
      if (result === undefined) throw new Error("Command output descriptor is not writable");
      const count = await result;
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.byteLength) {
        throw Object.assign(new Error("Invalid descriptor I/O count"), { code: "EIO" });
      }
      signal.throwIfAborted();
      return count;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EAGAIN") || !stream.poll) {
        throw error;
      }
      await stream.poll(direction, signal);
    }
  }
}
