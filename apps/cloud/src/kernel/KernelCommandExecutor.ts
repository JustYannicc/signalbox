import {
  callKernel,
  kernelError,
  type KernelErrorCode,
  type KernelHandle,
  type KernelResult,
} from "./KernelAbi.ts";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandExit,
  KernelCommandForwarder,
} from "./KernelCommandForwarder.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelFileByteSelection } from "./KernelFileBytes.ts";
import type { KernelProgramHost } from "./KernelProgramHost.ts";

export interface KernelCommandExecutorOptions {
  readonly host: KernelProgramHost;
  readonly filesystem: KernelFileSystem;
  readonly forwarder: KernelCommandForwarder;
  readonly parent?: KernelHandle<"process">;
  /** Admitted execution passes context home without filling HOME; legacy execution requires a matching HOME. */
  readonly home?: string;
  /** Trusted command binding; guest arguments cannot choose the file representation. */
  readonly fileBytes?: KernelFileByteSelection;
  /** The host's admission resolver owns placement for every command. */
  readonly admitted?: true;
}

/** Adapts kernel program processes to the command stream contract. */
export class KernelCommandExecutor implements KernelCommandForwarder {
  readonly #host: KernelProgramHost;
  readonly #filesystem: KernelFileSystem;
  readonly #forwarder: KernelCommandForwarder;
  readonly #parent: KernelHandle<"process"> | undefined;
  readonly #home: string | undefined;
  readonly #fileBytes: KernelFileByteSelection | undefined;
  readonly #admitted: boolean;

  constructor(options: KernelCommandExecutorOptions) {
    this.#host = options.host;
    this.#filesystem = options.filesystem;
    this.#forwarder = options.forwarder;
    this.#parent = options.parent;
    this.#home = options.home;
    this.#fileBytes = options.fileBytes;
    this.#admitted = options.admitted === true;
  }

  readonly spawn = async (
    command: KernelCommand,
    signal: AbortSignal,
  ): Promise<KernelCommandChild> => {
    throwIfAborted(signal);
    if (this.#admitted) {
      const input = {
        filesystem: this.#filesystem,
        signal,
        ...(this.#parent === undefined ? {} : { parent: this.#parent }),
        ...(this.#home === undefined ? {} : { home: this.#home }),
      };
      const options = this.#fileBytes === undefined ? {} : { fileBytes: this.#fileBytes };
      let result = await this.#host.spawnCommandPiped(input, command, options);
      while (result.status === "would_block") {
        await waitForWake(this.#host, result.wakeToken, signal);
        throwIfAborted(signal);
        result = await this.#host.spawnCommandPiped(input, command, options);
      }
      const { handle, piped } = resultValue(result, "run admitted command");
      return makeLocalChild(this.#host, piped, handle);
    }
    const resolution = await resolveProgram(this.#host, command.executable, signal);
    throwIfAborted(signal);
    if (resolution.status === "error" && resolution.error.code === "NOT_FOUND") {
      throwIfAborted(signal);
      return this.#forwarder.spawn(command, signal);
    }
    const program = resultValue(resolution, "resolve local program");

    const preparedHome = this.#home !== undefined && command.env.HOME === this.#home;
    const piped = this.#host.preparePiped(
      {
        filesystem: this.#filesystem,
        signal,
        ...(this.#parent === undefined ? {} : { parent: this.#parent }),
        // KernelProgramHost fills a missing HOME from `home`; only pass it when it
        // is already part of the caller's complete environment.
        ...(preparedHome ? { home: this.#home } : {}),
      },
      {
        cwd: command.cwd,
        ...(this.#fileBytes === undefined ? {} : { fileBytes: this.#fileBytes }),
      },
    );

    try {
      const backend = this.#host.backend(piped.prepared);
      const handle = await awaitKernelResult(
        this.#host,
        () =>
          callKernel(backend, "process.spawn", {
            program,
            args: command.argv,
            env: command.env,
          }),
        signal,
      );
      return makeLocalChild(this.#host, piped, handle);
    } finally {
      // The host transfers ownership on successful process.spawn; release() is
      // deliberately a no-op after that point.
      await piped.prepared.release();
    }
  };
}

async function resolveProgram(host: KernelProgramHost, executable: string, signal: AbortSignal) {
  let result = host.resolve(executable);
  while (result.status === "would_block") {
    await waitForWake(host, result.wakeToken, signal);
    throwIfAborted(signal);
    result = host.resolve(executable);
  }
  return result;
}

async function awaitKernelResult<T>(
  host: KernelProgramHost,
  attempt: () => KernelResult<T>,
  signal?: AbortSignal,
): Promise<T> {
  let result = attempt();
  while (result.status === "would_block") {
    await waitForWake(host, result.wakeToken, signal);
    throwIfAborted(signal);
    result = attempt();
  }
  return resultValue(result, "run local program");
}

async function waitForWake(
  host: KernelProgramHost,
  token: Parameters<KernelProgramHost["wakes"]["wait"]>[0],
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await host.wakes.wait(token, signal);
    if (result.status === "error") {
      throw new KernelCommandExecutionError(result.error.code, result.error.message);
    }
  } finally {
    host.wakes.release(token);
  }
}

function resultValue<T>(result: KernelResult<T>, operation: string): T {
  if (result.status === "ok") return result.value;
  if (result.status === "error") {
    throw new KernelCommandExecutionError(result.error.code, result.error.message);
  }
  throw new KernelCommandExecutionError("IO_ERROR", `${operation} remained blocked`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new KernelCommandExecutionError("CANCELLED", "Command was cancelled");
  }
}

function makeLocalChild(
  host: KernelProgramHost,
  piped: ReturnType<KernelProgramHost["preparePiped"]>,
  handle: KernelHandle<"process">,
): KernelCommandChild {
  let terminal = false;
  let reaped = false;
  let reapFailure: unknown;
  let reapPromise: Promise<void> | undefined;
  const outputDone = [false, false];

  const maybeReap = (): Promise<void> => {
    if (reaped || !terminal || !outputDone[0] || !outputDone[1]) return Promise.resolve();
    reapPromise ??= awaitKernelResult(host, () => host.reap(handle), undefined).then(
      () => {
        reaped = true;
        reapFailure = undefined;
      },
      (error: unknown) => {
        // A terminal process can fail its completion promise. KernelProcessTable
        // still removes that child when reap returns IO_ERROR, so confirm the
        // handle is gone before deciding whether another cleanup attempt is safe.
        const current = host.processes.info(handle);
        if (current.status === "error" && current.error.code === "INVALID_HANDLE") {
          reaped = true;
          reapFailure = undefined;
        } else {
          reapFailure = error;
          reapPromise = undefined;
        }
      },
    );
    return reapPromise;
  };

  const stdout = trackedOutput(piped.stdout, () => {
    outputDone[0] = true;
    void maybeReap();
  });
  const stderr = trackedOutput(piped.stderr, () => {
    outputDone[1] = true;
    void maybeReap();
  });

  const exited = readExitStatus(host, handle).then((result) => {
    terminal = true;
    void maybeReap();
    return resultValue(result, "read local program exit status");
  });
  // Cleanup observes this promise too, but callers may choose to ignore `exited`.
  void exited.catch(() => undefined);

  const inputWriter = piped.stdin.getWriter();
  let inputState: "open" | "closing" | "closed" | "aborted" = "open";
  let closeInputPromise: Promise<void> | undefined;
  const closeInput = (): Promise<void> => {
    if (inputState === "closed" || inputState === "aborted") return Promise.resolve();
    if (inputState === "closing") return closeInputPromise ?? Promise.resolve();
    inputState = "closing";
    closeInputPromise = inputWriter.close().then(
      () => {
        inputState = "closed";
      },
      async (error: unknown) => {
        inputState = "aborted";
        closeInputPromise = undefined;
        try {
          await inputWriter.abort(error);
        } catch {
          // A failed close may already have errored the stream.
        }
        throw error;
      },
    );
    return closeInputPromise;
  };
  const abortInput = (reason: unknown): Promise<void> => {
    if (inputState !== "open") return Promise.resolve();
    inputState = "aborted";
    return inputWriter.abort(reason);
  };
  const stdin = new WritableStream<Uint8Array>({
    write: (chunk) => inputWriter.write(chunk),
    close: closeInput,
    abort: abortInput,
  });

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      const failures: unknown[] = [];
      let terminationRequested = terminal;
      if (!terminal && !reaped) {
        try {
          const result = host.processes.signal(handle, 9);
          if (result.status === "error" && result.error.code !== "NOT_FOUND") {
            throw new KernelCommandExecutionError(result.error.code, result.error.message);
          }
          if (result.status === "would_block") {
            throw new KernelCommandExecutionError(
              "IO_ERROR",
              "Command child signal remained blocked",
            );
          }
          terminationRequested =
            result.status === "ok" ||
            (result.status === "error" && result.error.code === "NOT_FOUND");
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await closeInput();
      } catch (error) {
        failures.push(error);
      }
      if (terminationRequested) {
        try {
          await exited;
        } catch {
          // The execution error remains observable through `exited`.
        }
        await Promise.all([stdout.drain(), stderr.drain()]);
      }
      if (terminationRequested) await Promise.all([stdout.completed, stderr.completed]);
      await maybeReap();
      if (reapFailure !== undefined) await maybeReap();
      if (reapFailure !== undefined) failures.push(reapFailure);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Command child cleanup failed");
    })().catch((error: unknown) => {
      disposePromise = undefined;
      throw error;
    });
    return disposePromise;
  };

  return {
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    signal: async (number) => {
      try {
        return host.processes.signal(handle, number);
      } catch {
        return kernelError("IO_ERROR", "Command child signal failed");
      }
    },
    dispose,
  };
}

async function readExitStatus(
  host: KernelProgramHost,
  handle: KernelHandle<"process">,
): Promise<KernelResult<KernelCommandExit>> {
  let result = await host.exitStatus(handle);
  while (result.status === "would_block") {
    await waitForWake(host, result.wakeToken);
    result = await host.exitStatus(handle);
  }
  return result;
}

function trackedOutput(
  source: ReadableStream<Uint8Array>,
  onComplete: () => void,
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly completed: Promise<void>;
  readonly drain: () => Promise<void>;
} {
  const reader = source.getReader();
  let complete = false;
  let draining = false;
  let cancellation: Promise<void> | undefined;
  let publicController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let publicClosed = false;
  let readInFlight: Promise<void> | undefined;
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const markComplete = () => {
    if (complete) return;
    complete = true;
    onComplete();
    resolveCompleted();
  };
  const closePublic = () => {
    if (publicClosed || !publicController) return;
    publicClosed = true;
    try {
      publicController.close();
    } catch {
      // The public stream may have been cancelled by its consumer.
    }
  };
  const cancelSource = async (reason: unknown): Promise<void> => {
    if (complete) return;
    cancellation ??= (async () => {
      draining = true;
      await readInFlight;
      await reader.cancel(reason);
      markComplete();
    })().catch((error: unknown) => {
      cancellation = undefined;
      draining = false;
      throw error;
    });
    await cancellation;
  };
  const drain = async (): Promise<void> => {
    if (complete) return;
    if (cancellation) {
      await cancellation;
      return;
    }
    draining = true;
    await readInFlight;
    for (;;) {
      try {
        const result = await reader.read();
        if (result.done) {
          markComplete();
          closePublic();
          return;
        }
      } catch {
        markComplete();
        closePublic();
        return;
      }
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        publicController = controller;
      },
      async pull(controller) {
        if (draining || complete) return;
        readInFlight ??= reader
          .read()
          .then(
            (result) => {
              if (result.done) {
                markComplete();
                closePublic();
              } else if (!draining) {
                controller.enqueue(result.value);
              }
            },
            (error: unknown) => {
              markComplete();
              publicClosed = true;
              try {
                controller.error(error);
              } catch {
                // The public stream may have been cancelled by its consumer.
              }
            },
          )
          .finally(() => {
            readInFlight = undefined;
          });
        await readInFlight;
      },
      async cancel(reason) {
        await cancelSource(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, completed, drain };
}

class KernelCommandExecutionError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string) {
    super(message);
    this.name = "KernelCommandExecutionError";
    this.code = code;
  }
}
