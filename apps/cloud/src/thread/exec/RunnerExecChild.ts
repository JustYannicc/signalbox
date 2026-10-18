// @effect-diagnostics cryptoRandomUUID:off globalTimers:off - process ids and command receipts are owned by the Runner protocol.
import type { ExecCommand, ExecReport } from "@signalbox/runner-protocol/ExecProtocol";
import type {
  KernelCommand,
  KernelCommandChild,
  KernelCommandExit,
} from "../../kernel/KernelCommandForwarder.ts";
import { base64ToBytes, byteQueue, bytesToBase64 } from "./ExecBytes.ts";
import { ExecCommandAcks, ExecCommandRejected } from "./ExecCommandAcks.ts";

export interface RunnerExecChildOptions {
  readonly generation: number;
  readonly send: (command: ExecCommand) => void;
  readonly acknowledgementTimeoutMs: number;
  readonly releaseLease: () => Promise<void>;
  readonly onDone: (processId: string, release: Promise<void>) => void;
}

const MAX_INPUT_CHUNK_BYTES = 64 * 1024;
const localError = (message: string) => new Error(message);
const id = () => crypto.randomUUID();

/** One remote child and its ack, output, exit and EOF lifecycle. */
export class RunnerExecChild implements KernelCommandChild {
  readonly generation: number;
  readonly processId = id();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array>;
  readonly exited: Promise<KernelCommandExit>;
  readonly #options: RunnerExecChildOptions;
  readonly #output = { stdout: byteQueue(), stderr: byteQueue() };
  readonly #acks: ExecCommandAcks;
  readonly #closed: Promise<void>;
  readonly #resolveClosed: () => void;
  readonly #resolveExit: (exit: KernelCommandExit) => void;
  readonly #rejectExit: (error: Error) => void;
  #lastSequence = 0;
  #exitReceived = false;
  #closedReceived = false;
  #startSent = false;
  #started = false;
  #failed: Error | null = null;
  #disposePromise: Promise<void> | null = null;
  #releasePromise: Promise<void> | null = null;
  #removeAbort: (() => void) | null = null;

  constructor(options: RunnerExecChildOptions) {
    this.#options = options;
    this.generation = options.generation;
    this.#acks = new ExecCommandAcks(options.acknowledgementTimeoutMs);
    this.stdout = this.#output.stdout.readable;
    this.stderr = this.#output.stderr.readable;
    let resolveExit!: (exit: KernelCommandExit) => void;
    let rejectExit!: (error: Error) => void;
    this.exited = new Promise((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });
    void this.exited.catch(() => undefined);
    this.#resolveExit = resolveExit;
    this.#rejectExit = rejectExit;
    let resolveClosed!: () => void;
    this.#closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    this.stdin = new WritableStream<Uint8Array>({
      write: async (data) => {
        if (this.#failed !== null) throw this.#failed;
        if (this.#closedReceived || this.#exitReceived) throw localError("Process stdin is closed");
        for (let offset = 0; offset < Math.max(data.length, 1); offset += MAX_INPUT_CHUNK_BYTES) {
          const bytes = data.subarray(
            offset,
            Math.min(offset + MAX_INPUT_CHUNK_BYTES, data.length),
          );
          await this.#sendAwaitingAck({
            type: "stdin.write",
            generation: this.generation,
            processId: this.processId,
            writeId: id(),
            dataBase64: bytesToBase64(bytes),
          });
        }
      },
      close: async () => {
        if (this.#failed !== null) throw this.#failed;
        if (this.#closedReceived || this.#exitReceived) return;
        await this.#sendAwaitingAck({
          type: "stdin.close",
          generation: this.generation,
          processId: this.processId,
          requestId: id(),
        });
      },
      abort: async () => this.#cancel(),
    });
  }

  async start(command: KernelCommand, cwd: string, signal: AbortSignal) {
    if (signal.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : localError("Spawn cancelled");
      this.fail(error);
      throw error;
    }
    let abortedWhileStarting = false;
    let cancelPromise: Promise<void> | null = null;
    const cancel = () => {
      cancelPromise ??= this.#cancel();
      return cancelPromise;
    };
    const onAbort = () => {
      if (!this.#started) {
        abortedWhileStarting = true;
        return;
      }
      void cancel().catch(() => undefined);
    };
    this.#removeAbort = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.#startSent = true;
      await this.#sendAwaitingAck({
        type: "start",
        generation: this.generation,
        processId: this.processId,
        requestId: id(),
        executable: command.executable,
        argv: [...command.argv],
        cwd,
        env: { ...command.env },
      });
      this.#started = true;
    } catch (error) {
      const noProcess = startCreatedNoProcess(error);
      if (noProcess) this.#startSent = false;
      this.fail(asError(error));
      if (noProcess) this.#finishOwnership();
      throw error;
    }
    if (signal.aborted || abortedWhileStarting) {
      try {
        await cancel();
      } catch (error) {
        this.fail(asError(error));
        throw error;
      }
      throw signal.reason instanceof Error ? signal.reason : localError("Spawn cancelled");
    }
  }

  readonly signal: KernelCommandChild["signal"] = async (signal) => {
    if (!Number.isSafeInteger(signal) || signal < 0) {
      return {
        status: "error",
        error: { code: "INVALID_ARGUMENT", message: "Invalid process signal" },
      };
    }
    if (this.#failed !== null || this.#closedReceived || this.#exitReceived) {
      return {
        status: "error",
        error: { code: "INVALID_HANDLE", message: "Process is no longer running" },
      };
    }
    try {
      await this.#sendAwaitingAck({
        type: "signal",
        generation: this.generation,
        processId: this.processId,
        requestId: id(),
        signal,
      });
      return { status: "ok", value: undefined };
    } catch (error) {
      return { status: "error", error: { code: "IO_ERROR", message: asError(error).message } };
    }
  };

  readonly dispose = () => {
    if (this.#disposePromise !== null) return this.#disposePromise;
    const disposal = (async () => {
      if (this.#closedReceived) return this.#releaseLease();
      try {
        if (!this.#exitReceived) await this.#cancel();
        await withTimeout(
          this.#closed,
          this.#options.acknowledgementTimeoutMs,
          "Timed out waiting for Runner process cleanup",
        );
        await this.#releaseLease();
      } catch (error) {
        this.fail(asError(error));
        throw error;
      }
    })();
    this.#disposePromise = disposal;
    void disposal.catch(() => {
      if (this.#disposePromise === disposal) this.#disposePromise = null;
    });
    return disposal;
  };

  report(report: ExecReport) {
    if (
      report.generation !== this.generation ||
      report.processId !== this.processId ||
      this.#closedReceived
    )
      return;
    if (report.type === "ack") {
      this.#acks.report(report);
      return;
    }
    if (report.sequence !== this.#lastSequence + 1) {
      this.fail(localError("Runner exec output sequence was out of order"));
      return;
    }
    this.#lastSequence = report.sequence;
    if (report.type === "output") {
      try {
        if (!this.#output[report.stream].push(base64ToBytes(report.dataBase64))) {
          this.fail(localError("Runner process output exceeded the unread stream buffer"));
        }
      } catch {
        this.fail(localError("Runner emitted invalid exec output"));
      }
      return;
    }
    if (report.type === "exit") {
      if (this.#exitReceived) {
        this.fail(localError("Runner reported process exit more than once"));
        return;
      }
      this.#exitReceived = true;
      this.#resolveExit(
        "exitCode" in report
          ? { exitCode: report.exitCode, signal: 0, coreDumped: false }
          : { exitCode: 0, signal: report.signal, coreDumped: report.coreDumped },
      );
      return;
    }
    if (!this.#exitReceived) {
      this.fail(localError("Runner closed process streams before reporting exit"));
      return;
    }
    this.#closedReceived = true;
    this.#removeAbort?.();
    this.#removeAbort = null;
    this.#output.stdout.close();
    this.#output.stderr.close();
    this.#resolveClosed();
    this.#options.onDone(this.processId, this.#releaseLease());
  }

  fail(error: Error) {
    if (this.#failed !== null || this.#closedReceived) return;
    if (this.#startSent && !this.#exitReceived) this.#bestEffortCancel();
    this.#failed = error;
    this.#removeAbort?.();
    this.#removeAbort = null;
    this.#output.stdout.error(error);
    this.#output.stderr.error(error);
    this.#rejectExit(error);
    this.#acks.fail(error);
    if (!this.#startSent) this.#finishOwnership();
  }

  /** Called only when the owner confirms this generation can no longer run processes. */
  generationEnded(error: Error) {
    this.fail(error);
    this.#finishOwnership();
  }

  #finishOwnership() {
    if (this.#closedReceived) return;
    this.#closedReceived = true;
    this.#resolveClosed();
    this.#options.onDone(this.processId, this.#releaseLease());
  }

  #sendAwaitingAck(command: ExecCommand) {
    return this.#acks.send(command, this.#options.send);
  }

  #bestEffortCancel() {
    try {
      this.#options.send({
        type: "cancel",
        generation: this.generation,
        processId: this.processId,
        requestId: id(),
      });
    } catch {
      // The lease or socket may already be gone.
    }
  }

  async #cancel() {
    if (this.#closedReceived) return;
    await this.#sendAwaitingAck({
      type: "cancel",
      generation: this.generation,
      processId: this.processId,
      requestId: id(),
    });
  }

  #releaseLease() {
    if (this.#releasePromise !== null) return this.#releasePromise;
    const release = Promise.resolve().then(this.#options.releaseLease);
    this.#releasePromise = release;
    void release.catch(() => {
      if (this.#releasePromise === release) this.#releasePromise = null;
    });
    return release;
  }
}

function startCreatedNoProcess(error: unknown) {
  return (
    error instanceof ExecCommandRejected &&
    error.report.operation === "start" &&
    error.report.error !== undefined &&
    [
      "stale_generation",
      "request_receipt_limit",
      "process_limit",
      "workspace_not_ready",
      "invalid_cwd",
      "process_error",
    ].includes(error.report.error.code)
  );
}

function asError(error: unknown) {
  return error instanceof Error ? error : localError("Runner exec operation failed");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(localError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
