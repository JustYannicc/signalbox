import type { KernelFileSystem, WasiStdio } from "./KernelFileSystem.ts";
import { KernelPipe } from "./KernelPipe.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import {
  readEndpoint,
  writeEndpoint,
  readable,
  writable,
  trackPipeIo,
} from "./program/KernelProgramPipes.ts";

export interface KernelSessionStdio {
  readonly filesystem: KernelFileSystem;
  readonly signal: AbortSignal;
  readonly finish: () => void;
  readonly stopInput: (reason?: unknown) => void;
  readonly stdio: readonly [WasiStdio, WasiStdio, WasiStdio];
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly assertBound: (filesystem: KernelFileSystem) => void;
  readonly dispose: () => Promise<void>;
}

export type KernelSessionOutputObserver = (fd: 1 | 2, bytes: Uint8Array) => void | Promise<void>;

/** Construct the filesystem with this tuple before giving that filesystem to Computer. */
export function createKernelSessionStdio(
  wakes: KernelWakeRegistry,
  signal?: AbortSignal,
  observe?: KernelSessionOutputObserver,
): KernelSessionStdio {
  const inputController = new AbortController();
  const inputSignal =
    signal === undefined
      ? inputController.signal
      : AbortSignal.any([signal, inputController.signal]);
  const input = new KernelPipe(wakes);
  const output = new KernelPipe(wakes);
  const error = new KernelPipe(wakes);
  const pending = new Set<Promise<unknown>>();
  const trackEndpoint = (endpoint: WasiStdio, fd: 0 | 1 | 2): WasiStdio => {
    const track = <T>(value: T | Promise<T>): T | Promise<T> =>
      value instanceof Promise ? trackPipeIo(value, pending) : value;
    return {
      ...endpoint,
      ...(endpoint.readInto === undefined
        ? {}
        : {
            readInto: (target, flags) => track(endpoint.readInto!(target, flags)),
          }),
      ...(endpoint.write === undefined
        ? {}
        : {
            write: (source, flags) => {
              const snapshot = observe === undefined || fd === 0 ? undefined : source.slice();
              const accepted = (count: number) => {
                if (snapshot !== undefined && count > 0 && fd !== 0) {
                  // Observers cannot consume SDK streams or turn an accepted write into a retry.
                  try {
                    const observed = observe!(fd, snapshot.slice(0, count));
                    if (observed instanceof Promise) void observed.catch(() => undefined);
                  } catch {
                    /* Output ownership stays with the writer. */
                  }
                }
                return count;
              };
              const written = endpoint.write!(source, flags);
              return track(written instanceof Promise ? written.then(accepted) : accepted(written));
            },
          }),
      ...(endpoint.poll === undefined
        ? {}
        : {
            poll: (direction, signal) => track(endpoint.poll!(direction, signal)),
          }),
    };
  };
  const stdio = [
    trackEndpoint(readEndpoint(input, wakes, inputSignal), 0),
    trackEndpoint(writeEndpoint(output, wakes), 1),
    trackEndpoint(writeEndpoint(error, wakes), 2),
  ] as const;
  let owner: KernelFileSystem | undefined;
  let disposed: Promise<void> | undefined;
  const finish = () => {
    output.closeWriter();
    error.closeWriter();
  };
  const stopInput = (reason?: unknown) => {
    inputController.abort(reason);
    input.closeWriter();
    input.closeReader();
  };
  return {
    get filesystem() {
      if (owner === undefined) throw new Error("Bind kernel session stdio to its filesystem first");
      return owner;
    },
    finish,
    stopInput,
    signal: inputSignal,
    stdio,
    stdin: writable(input, inputSignal, pending),
    stdout: readable(output, signal, pending),
    stderr: readable(error, signal, pending),
    assertBound(filesystem) {
      if (disposed !== undefined) throw new Error("Kernel session stdio is disposed");
      if (owner !== undefined && owner !== filesystem) {
        throw new Error("Kernel session stdio already belongs to another filesystem");
      }
      for (const [fd, stream] of stdio.entries()) {
        const descriptor = filesystem.descriptors.get(fd);
        if (descriptor.kind !== "stdio" || descriptor.stdio !== stream) {
          throw new Error(`Kernel session stdio does not match filesystem fd ${fd}`);
        }
      }
      owner = filesystem;
    },
    dispose() {
      disposed ??= (async () => {
        stopInput();
        finish();
        while (pending.size > 0) await Promise.allSettled(pending);
      })();
      return disposed;
    },
  };
}
