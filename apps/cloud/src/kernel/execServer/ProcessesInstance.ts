import { CodexExecOutputLog, type OutputLogRead } from "../CodexExecOutputLog.ts";
import type { KernelCommandChild } from "../KernelCommandForwarder.ts";
import type { KernelResult } from "../KernelAbi.ts";
import { RpcError, type Notification } from "../CodexExecProtocol.ts";
import { ProcessesInput } from "./ProcessesInput.ts";

type ReadParams = ReturnType<typeof import("../CodexExecProtocol.ts").readParams>;

export type ProcessReadResponse = Omit<OutputLogRead, "failure"> & {
  readonly failure: string | null;
};

export interface ProcessesInstanceOptions {
  readonly processId: string;
  readonly identity: string;
  readonly child: KernelCommandChild;
  readonly pipeStdin: boolean;
  readonly notify: (message: Notification) => Promise<void>;
  readonly maxWriteIds: number;
  readonly maxWriteBytes: number;
  readonly maxDedupBytes: number;
  readonly onClosed: (process: ProcessesInstance) => void;
  readonly onCleanupFailure: (process: ProcessesInstance, error: unknown) => void;
}

const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;

export class ProcessesInstance {
  readonly processId: string;
  readonly identity: string;
  readonly log = new CodexExecOutputLog();
  readonly #child: KernelCommandChild;
  readonly #notify: ProcessesInstanceOptions["notify"];
  readonly #onClosed: ProcessesInstanceOptions["onClosed"];
  readonly #onCleanupFailure: ProcessesInstanceOptions["onCleanupFailure"];
  readonly #failureWake = new AbortController();
  readonly #input: ProcessesInput;
  #stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  #stderrReader: ReadableStreamDefaultReader<Uint8Array>;
  #notificationTail: Promise<void> = Promise.resolve();
  #openStreams = 2;
  #exitCode: number | undefined;
  #failure: string | null = null;
  #closed = false;
  #disposing = false;
  #childDisposed = false;
  #disposePromise: Promise<void> | undefined;
  #childDisposePromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProcessesInstanceOptions) {
    this.processId = options.processId;
    this.identity = options.identity;
    this.#child = options.child;
    this.#notify = options.notify;
    this.#onClosed = options.onClosed;
    this.#onCleanupFailure = options.onCleanupFailure;
    this.#stdoutReader = options.child.stdout.getReader();
    this.#stderrReader = options.child.stderr.getReader();
    this.#input = new ProcessesInput({
      writer: options.child.stdin.getWriter(),
      pipeStdin: options.pipeStdin,
      maxWriteIds: options.maxWriteIds,
      maxWriteBytes: options.maxWriteBytes,
      maxDedupBytes: options.maxDedupBytes,
    });
  }

  get exited() {
    return this.#exitCode !== undefined;
  }

  get closed() {
    return this.#closed;
  }

  get childDisposed() {
    return this.#childDisposed;
  }

  start() {
    this.#input.start();
    void this.#pump("stdout", this.#stdoutReader);
    void this.#pump("stderr", this.#stderrReader);
    void this.#watchExit();
  }

  async read(params: ReadParams, signal: AbortSignal): Promise<ProcessReadResponse> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const onFailure = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.#failureWake.signal.addEventListener("abort", onFailure, { once: true });
    if (signal.aborted) onAbort();
    if (this.#failure !== null) onFailure();
    const readOptions = {
      ...(params.afterSeq === undefined ? {} : { afterSeq: params.afterSeq }),
      ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
    };
    try {
      const result = await this.log.read(
        {
          ...readOptions,
          ...(params.waitMs === undefined ? {} : { waitMs: params.waitMs }),
        },
        controller.signal,
      );
      return this.#withFailure(result);
    } catch (error) {
      if (signal.aborted) throw error;
      if (this.#failure === null) throw error;
      return this.#withFailure(await this.log.read(readOptions));
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#failureWake.signal.removeEventListener("abort", onFailure);
    }
  }

  write(writeId: string, bytes: Uint8Array, signal: AbortSignal) {
    return this.#input.write(writeId, bytes, signal);
  }

  async signal(signal: number) {
    if (this.exited || this.#closed || this.#disposing) return;
    await requireAcknowledged(await this.#child.signal(signal), "signal process");
  }

  async terminate() {
    if (this.exited || this.#closed || this.#disposing) return false;
    await this.signal(15);
    return true;
  }

  async dispose() {
    this.#disposing = true;
    this.#input.beginDispose();
    this.log.dispose();
    if (this.#disposePromise) return this.#disposePromise;
    const cleanup = this.#disposeChild(/* stopRunning */ true);
    this.#disposePromise = cleanup;
    try {
      await cleanup;
    } finally {
      this.#disposePromise = undefined;
    }
  }

  async #pump(stream: "stdout" | "stderr", reader: ReadableStreamDefaultReader<Uint8Array>) {
    try {
      while (!this.#disposing) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        for (let offset = 0; offset < value.byteLength; offset += MAX_OUTPUT_CHUNK_BYTES) {
          const end = Math.min(offset + MAX_OUTPUT_CHUNK_BYTES, value.byteLength);
          const output = this.log.append(stream, value.subarray(offset, end));
          await this.#send({
            method: "process/output",
            params: { processId: this.processId, ...output },
          });
        }
      }
    } catch {
      if (!this.#disposing) this.#setFailure(`${stream} output stream failed`);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // An active reader owns its lock until this finally block.
      }
      this.#openStreams--;
      await this.#maybeClose();
    }
  }

  async #watchExit() {
    let exitCode = -1;
    try {
      exitCode = wireExitCode(await this.#child.exited);
    } catch {
      // Codex 0.162.1 reports -1 when the executor loses its exit-status channel.
    }
    if (this.#disposing) return;
    this.#exitCode = exitCode;
    this.#input.markExited();
    const exited = this.log.exited(exitCode);
    await this.#send({
      method: "process/exited",
      params: { processId: this.processId, seq: exited.seq, exitCode, sandboxDenied: false },
    });
    await this.#maybeClose();
  }

  async #maybeClose() {
    if (this.#closed || !this.exited || this.#openStreams !== 0 || this.#disposing) return;
    if (this.#closePromise) return this.#closePromise;
    const closing = (async () => {
      try {
        await this.#disposeChild(/* stopRunning */ false);
        if (this.#disposing) return;
        const closed = this.log.close();
        this.#closed = true;
        await this.#send({
          method: "process/closed",
          params: { processId: this.processId, seq: closed.seq },
        });
        this.#onClosed(this);
      } catch (error) {
        this.#onCleanupFailure(this, error);
      }
    })();
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    }
  }

  async #disposeChild(stopRunning: boolean) {
    if (this.#childDisposed) return;
    if (this.#childDisposePromise) return this.#childDisposePromise;
    const disposing = this.#disposeChildOnce(stopRunning);
    this.#childDisposePromise = disposing;
    try {
      await disposing;
    } finally {
      if (this.#childDisposePromise === disposing) this.#childDisposePromise = undefined;
    }
  }

  async #disposeChildOnce(stopRunning: boolean) {
    let signalError: unknown;
    if (stopRunning && !this.exited) {
      try {
        await requireAcknowledged(await this.#child.signal(15), "stop process");
      } catch (error) {
        signalError = error;
      }
    }
    this.#input.beginDispose();
    try {
      await this.#child.dispose();
      await this.#input.waitForWrites();
      this.#childDisposed = true;
    } catch (disposeError) {
      if (signalError !== undefined) {
        throw new AggregateError(
          [signalError, disposeError],
          "Failed to stop and dispose process",
          { cause: disposeError },
        );
      }
      throw disposeError;
    } finally {
      await Promise.allSettled([
        Promise.resolve().then(() => this.#stdoutReader.cancel()),
        Promise.resolve().then(() => this.#stderrReader.cancel()),
      ]);
      this.#input.release();
    }
  }

  #send(message: Notification) {
    const send = this.#notificationTail.then(async () => {
      try {
        await this.#notify(message);
      } catch {
        // Detached sessions replay process events after reconnect.
      }
    });
    this.#notificationTail = send;
    return send;
  }

  #setFailure(message: string) {
    if (this.#failure !== null) return;
    this.#failure = message;
    this.#failureWake.abort();
    void this.signal(15).catch(() => {});
  }

  #withFailure(response: OutputLogRead): ProcessReadResponse {
    return { ...response, failure: this.#failure };
  }
}

function requireAcknowledged(result: KernelResult<void>, operation: string) {
  if (result.status === "ok") return;
  if (result.status === "error") {
    throw new RpcError(-32603, `Failed to ${operation}: ${result.error.message}`);
  }
  throw new RpcError(-32603, `Failed to ${operation}: remote acknowledgement is pending`);
}

function wireExitCode(status: { readonly exitCode: number; readonly signal: number }) {
  if (!Number.isInteger(status.exitCode) || !Number.isInteger(status.signal) || status.signal < 0) {
    return -1;
  }
  const code = status.signal === 0 ? status.exitCode : 128 + status.signal;
  return code >= -2_147_483_648 && code <= 2_147_483_647 ? code : -1;
}
