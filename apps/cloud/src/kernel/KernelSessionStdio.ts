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
  /** Observe pipe acceptance on fd 0 and accepted CLI writes on fds 1 and 2. */
  readonly observeAcceptedWrites: (observer: KernelSessionAcceptedWriteObserver) => () => void;
  readonly assertBound: (filesystem: KernelFileSystem) => void;
  readonly dispose: () => Promise<void>;
}

export type KernelSessionInputObserver = (bytes: Uint8Array) => void | Promise<void>;
export type KernelSessionOutputObserver = (fd: 1 | 2, bytes: Uint8Array) => void | Promise<void>;
export type KernelSessionAcceptedWriteObserver = (fd: 0 | 1 | 2, bytes: Uint8Array) => void;

/** Construct the filesystem with this tuple before giving that filesystem to Computer. */
export function createKernelSessionStdio(
  wakes: KernelWakeRegistry,
  signal?: AbortSignal,
  observe?: KernelSessionOutputObserver,
  observeInput?: KernelSessionInputObserver,
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
  const acceptedWriteObservers = new Set<{
    readonly observer: KernelSessionAcceptedWriteObserver;
  }>();
  const notifyAcceptedWrite = (fd: 0 | 1 | 2, bytes: Uint8Array) => {
    if (acceptedWriteObservers.size === 0) return;
    for (const { observer } of Array.from(acceptedWriteObservers)) {
      try {
        const observed: unknown = observer(fd, new Uint8Array(bytes));
        if (observed instanceof Promise) void observed.catch(() => undefined);
      } catch {
        /* Observation cannot change pipe ownership or write results. */
      }
    }
  };
  const trackEndpoint = (endpoint: WasiStdio, fd: 0 | 1 | 2): WasiStdio => {
    const track = <T>(value: T | Promise<T>): T | Promise<T> =>
      value instanceof Promise ? trackPipeIo(value, pending) : value;
    return {
      ...endpoint,
      ...(endpoint.readInto === undefined
        ? {}
        : {
            readInto: (target, flags) => {
              const consumed = (count: number) => {
                if (observeInput !== undefined && fd === 0 && count > 0) {
                  // Capture the consumed prefix before the guest can reuse its memory.
                  try {
                    const observed = observeInput(new Uint8Array(target.subarray(0, count)));
                    if (observed instanceof Promise) void observed.catch(() => undefined);
                  } catch {
                    /* Input ownership stays with the reader. */
                  }
                }
                return count;
              };
              const read = endpoint.readInto!(target, flags);
              return track(read instanceof Promise ? read.then(consumed) : consumed(read));
            },
          }),
      ...(endpoint.write === undefined
        ? {}
        : {
            write: (source, flags) => {
              const snapshot =
                fd === 0 || (observe === undefined && acceptedWriteObservers.size === 0)
                  ? undefined
                  : new Uint8Array(source);
              const accepted = (count: number) => {
                if (snapshot !== undefined && count > 0) {
                  // Capture accepted bytes before guest memory can be reused.
                  const captured = snapshot.slice(0, count);
                  notifyAcceptedWrite(fd, captured);
                  try {
                    if (fd !== 0 && observe !== undefined) {
                      const observed = observe(fd, captured);
                      if (observed instanceof Promise) void observed.catch(() => undefined);
                    }
                  } catch {
                    /* Observation cannot change accepted pipe bytes. */
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
    stdin: writable(input, inputSignal, pending, (bytes) => notifyAcceptedWrite(0, bytes)),
    stdout: readable(output, signal, pending),
    stderr: readable(error, signal, pending),
    observeAcceptedWrites(observer) {
      if (disposed !== undefined) throw new Error("Kernel session stdio is disposed");
      const subscription = { observer };
      acceptedWriteObservers.add(subscription);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        acceptedWriteObservers.delete(subscription);
      };
    },
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
        acceptedWriteObservers.clear();
      })();
      return disposed;
    },
  };
}
