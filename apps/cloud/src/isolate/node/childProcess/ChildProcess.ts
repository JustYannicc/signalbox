// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node child_process requires native streams and its timeout option uses the host timer.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";

import {
  prepareNodeChildStdioKernelProgram,
  type KernelExitStatus,
  type KernelNodeChildStdioProgram,
  type KernelProgramHost,
  type KernelProgramPrepareInput,
} from "../../../kernel/KernelProgramHost.ts";
import { callKernel, type KernelHandle, type ResolvedProgram } from "../../../kernel/KernelAbi.ts";
import type { NodeProcessHostContext } from "../process/context.ts";
import { unsupportedNodeOperation } from "../process/NodeError.ts";
import { abortError, asChildProcessError, isCode, unwrapHostResult } from "./errors.ts";
import { normalizeSignal, signalName, type NormalizedSpawn } from "./arguments.ts";

export type NodeChildProcessContext = KernelProgramPrepareInput &
  Pick<NodeProcessHostContext, "env">;

const synchronousSpawnErrors = new WeakMap<NodeChildProcess, Error>();

export function getSynchronousSpawnError(child: NodeChildProcess): Error | undefined {
  return synchronousSpawnErrors.get(child);
}

export type NodeChildProcessWithPipes = NodeChildProcess & {
  readonly stdin: NodeStream.PassThrough;
  readonly stdout: NodeStream.PassThrough;
  readonly stderr: NodeStream.PassThrough;
  readonly stdio: readonly [NodeStream.PassThrough, NodeStream.PassThrough, NodeStream.PassThrough];
};

export class NodeChildProcess extends NodeEvents.EventEmitter {
  readonly stdin: NodeStream.PassThrough | null;
  readonly stdout: NodeStream.PassThrough | null;
  readonly stderr: NodeStream.PassThrough | null;
  readonly stdio: readonly [
    NodeStream.PassThrough | null,
    NodeStream.PassThrough | null,
    NodeStream.PassThrough | null,
  ];
  readonly spawnfile: string;
  readonly spawnargs: string[];

  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  timedOut = false;
  connected = false;

  readonly #host: KernelProgramHost;
  readonly #context: NodeChildProcessContext;
  readonly #spawn: NormalizedSpawn;
  readonly #hostAbortController = new AbortController();
  readonly #abortListeners = new Map<AbortSignal, () => void>();
  #handle: KernelHandle<"process"> | undefined;
  #preparedReleased = true;
  #spawnEventQueued = false;
  #spawnEventEmitted = false;
  #statusUnavailable = false;
  #exitSeen = false;
  #stdoutClosed = false;
  #stderrClosed = false;
  #closeEmitted = false;
  #errorEmitted = false;
  #errorScheduled = false;
  #timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(host: KernelProgramHost, context: NodeChildProcessContext, spawn: NormalizedSpawn) {
    super();
    this.#host = host;
    this.#context = context;
    this.#spawn = spawn;
    this.spawnfile = spawn.spawnfile;
    this.spawnargs = [...spawn.argv];
    this.stdin = spawn.stdio[0] === "pipe" ? new NodeStream.PassThrough() : null;
    this.stdout = spawn.stdio[1] === "pipe" ? new NodeStream.PassThrough() : null;
    this.stderr = spawn.stdio[2] === "pipe" ? new NodeStream.PassThrough() : null;
    this.stdio = [this.stdin, this.stdout, this.stderr];
    this.#stdoutClosed = this.stdout === null;
    this.#stderrClosed = this.stderr === null;

    this.stdout?.once("close", () => {
      this.#stdoutClosed = true;
      this.#emitCloseIfReady();
    });
    this.stderr?.once("close", () => {
      this.#stderrClosed = true;
      this.#emitCloseIfReady();
    });
    this.stdin?.on("error", (error: Error) => this.#onPipeError(error));
    this.stdout?.on("error", (error: Error) => this.#onPipeError(error));
    this.stderr?.on("error", (error: Error) => this.#onPipeError(error));
  }

  start(): void {
    const signals = new Set(
      [this.#context.signal, this.#spawn.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );
    const alreadyAborted = [...signals].find((signal) => signal.aborted);
    if (alreadyAborted) {
      if (alreadyAborted === this.#context.signal) {
        this.#hostAbortController.abort(alreadyAborted.reason);
      }
      this.#fail(abortError());
      return;
    }

    for (const signal of signals) {
      const listener = () => {
        if (signal === this.#context.signal) this.#hostAbortController.abort(signal.reason);
        if (signal === this.#spawn.signal) this.#abortSpawn();
      };
      this.#abortListeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }

    this.#spawnHost();
  }

  kill(signal?: string | number): boolean {
    if (this.#handle === undefined || this.pid === undefined || this.#exitSeen) return false;
    const number = normalizeSignal(signal);
    try {
      unwrapHostResult(
        this.#host.processes.signalPid(this.#context.parent, this.pid, number),
        "signal",
      );
      this.killed = true;
      return true;
    } catch (error) {
      if (isCode(error, "ESRCH")) return false;
      throw error;
    }
  }

  send(..._args: unknown[]): never {
    return unsupportedNodeOperation("child_process IPC");
  }

  disconnect(): never {
    return unsupportedNodeOperation("child_process IPC");
  }

  #spawnHost(): void {
    let prepared: KernelNodeChildStdioProgram | undefined;
    try {
      if (this.#hostAbortController.signal.aborted) {
        this.#fail(abortError());
        return;
      }
      const program = unwrapHostResult(
        this.#host.resolve(this.#spawn.executable),
        "spawn",
      ) as ResolvedProgram;
      const input = { ...this.#context, signal: this.#hostAbortController.signal };
      if (this.#spawn.stdio.every((mode) => mode === "pipe")) {
        const piped = this.#host.preparePiped(input, { cwd: this.#spawn.cwd });
        prepared = {
          prepared: piped.prepared,
          stdin: piped.stdin,
          stdout: piped.stdout,
          stderr: piped.stderr,
        };
      } else {
        if (typeof this.#host.wakes?.register !== "function") {
          throw new TypeError("child_process stdio requires the kernel wake registry");
        }
        prepared = prepareNodeChildStdioKernelProgram(
          this.#host.wakes,
          input,
          { cwd: this.#spawn.cwd },
          this.#spawn.stdio,
        );
      }
      this.#preparedReleased = false;
      this.#connectPipes(prepared);

      const backend = this.#host.backend(prepared.prepared);
      const spawned = callKernel(backend, "process.spawn", {
        program,
        args: this.#spawn.argv,
        env: this.#spawn.env,
      });
      const handle = unwrapHostResult(spawned, "spawn") as KernelHandle<"process">;
      this.#handle = handle;
      const info = unwrapHostResult(this.#host.processes.info(handle), "wait") as
        | { readonly pid?: unknown }
        | null
        | undefined;
      const pid = info?.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 2 || pid > 0x7fff_ffff) {
        throw Object.assign(new Error("Kernel process admission did not provide a child PID"), {
          code: "EIO",
          syscall: "spawn",
        });
      }
      this.pid = pid;
      this.#queueSpawn(handle);
      if (this.#spawn.signal?.aborted) this.#abortSpawn();
    } catch (error) {
      this.#fail(error);
      if (this.#handle !== undefined && this.pid === undefined) {
        void this.#finishFailedSpawn(this.#handle);
      }
    } finally {
      this.#releasePrepared(prepared);
    }
  }

  async #finishFailedSpawn(handle: KernelHandle<"process">): Promise<void> {
    try {
      await this.#host.exitStatus(handle);
    } catch {
      // The original synchronous spawn failure is the useful error for this child.
    }
    if (this.#exitSeen) return;
    this.#exitSeen = true;
    this.#statusUnavailable = true;
    this.#clearTimeout();
    this.#removeAbortListeners();
    this.#emitCloseIfReady();
  }

  #queueSpawn(handle: KernelHandle<"process">): void {
    if (this.#spawnEventQueued) return;
    this.#spawnEventQueued = true;
    queueMicrotask(() => {
      this.#spawnEventEmitted = true;
      this.#safeEmit("spawn");
      if (this.#spawn.timeout > 0) {
        this.#timeout = setTimeout(() => {
          if (this.#exitSeen) return;
          this.timedOut = true;
          try {
            this.kill(this.#spawn.killSignal);
          } catch (error) {
            this.#reportError(asChildProcessError(error));
          }
        }, this.#spawn.timeout);
      }
      void this.#waitForExit(handle);
    });
  }

  #releasePrepared(prepared: KernelNodeChildStdioProgram | undefined): void {
    if (prepared === undefined) return;
    void (async () => {
      try {
        await prepared.prepared.release();
      } catch (error) {
        if (this.#exitSeen) this.#scheduleError(asChildProcessError(error));
        else this.#fail(error);
      } finally {
        this.#preparedReleased = true;
        this.#emitCloseIfReady();
      }
    })();
  }

  #connectPipes(prepared: KernelNodeChildStdioProgram): void {
    if (this.stdin !== null && prepared.stdin !== undefined) {
      const stdin = NodeStream.Writable.fromWeb(
        prepared.stdin as NodeStreamWeb.WritableStream<Uint8Array>,
      );
      this.stdin.once("close", () => stdin.destroy());
      stdin.on("error", (error: Error) => this.stdin?.destroy(error));
      this.stdin.pipe(stdin);
    }
    if (this.stdout !== null && prepared.stdout !== undefined) {
      const stdout = NodeStream.Readable.fromWeb(
        prepared.stdout as NodeStreamWeb.ReadableStream<Uint8Array>,
      );
      stdout.once("close", () => {
        if (this.stdout && !this.stdout.writableEnded) this.stdout.end();
      });
      this.stdout.once("close", () => stdout.destroy());
      stdout.on("error", (error: Error) => this.stdout?.destroy(error));
      stdout.pipe(this.stdout);
    }
    if (this.stderr !== null && prepared.stderr !== undefined) {
      const stderr = NodeStream.Readable.fromWeb(
        prepared.stderr as NodeStreamWeb.ReadableStream<Uint8Array>,
      );
      stderr.once("close", () => {
        if (this.stderr && !this.stderr.writableEnded) this.stderr.end();
      });
      this.stderr.once("close", () => stderr.destroy());
      stderr.on("error", (error: Error) => this.stderr?.destroy(error));
      stderr.pipe(this.stderr);
    }
  }

  async #waitForExit(handle: KernelHandle<"process">): Promise<void> {
    try {
      const status = unwrapHostResult(
        await this.#host.exitStatus(handle),
        "wait",
      ) as KernelExitStatus;
      this.#onExit(status);
    } catch (error) {
      this.#finishWithoutStatus(error);
    }
  }

  #onExit(exit: KernelExitStatus): void {
    if (this.#exitSeen) return;
    this.#exitSeen = true;
    this.#clearTimeout();
    this.#removeAbortListeners();
    this.signalCode = signalName(exit.signal);
    this.exitCode = this.signalCode === null ? exit.exitCode : null;
    this.stdin?.end();
    this.#safeEmit("exit", this.exitCode, this.signalCode);
    this.stdout?.resume();
    this.stderr?.resume();
    this.#emitCloseIfReady();
  }

  #fail(value: unknown): void {
    if (this.#closeEmitted || this.#exitSeen) {
      this.#scheduleError(asChildProcessError(value));
      return;
    }
    const error = asChildProcessError(value);
    if (this.pid === undefined && !this.#spawnEventQueued) {
      synchronousSpawnErrors.set(this, error);
    }
    this.#scheduleError(error);
    if (this.#handle === undefined) {
      this.#statusUnavailable = true;
      this.#exitSeen = true;
      this.#clearTimeout();
      this.#removeAbortListeners();
      this.stdin?.destroy();
      this.stdout?.destroy();
      this.stderr?.destroy();
      this.#emitCloseIfReady();
      return;
    }

    this.#clearTimeout();
    this.stdin?.destroy();
    this.stdout?.destroy();
    this.stderr?.destroy();
    try {
      const signal = normalizeSignal("SIGTERM");
      const result =
        this.pid === undefined
          ? this.#host.processes.signal(this.#handle, signal)
          : this.#host.processes.signalPid(this.#context.parent, this.pid, signal);
      unwrapHostResult(result, "signal");
    } catch {
      // The process may have exited while its stdio stream failed.
    }
  }

  #finishWithoutStatus(value: unknown): void {
    if (this.#closeEmitted || this.#exitSeen) return;
    this.#statusUnavailable = true;
    this.#exitSeen = true;
    this.#clearTimeout();
    this.#removeAbortListeners();
    this.#reportError(asChildProcessError(value));
    this.stdin?.destroy();
    this.stdout?.destroy();
    this.stderr?.destroy();
    this.#emitCloseIfReady();
  }

  #stopOnPipeFailure(): void {
    if (this.#handle !== undefined && !this.#exitSeen) {
      try {
        this.kill("SIGTERM");
      } catch {
        // The process may have exited while its stdio stream failed.
      }
    }
  }

  #emitAbort(): void {
    if (this.#exitSeen || this.#errorEmitted || this.#errorScheduled) return;
    this.#scheduleError(abortError());
  }

  #abortSpawn(): void {
    if (this.#exitSeen) return;
    this.#emitAbort();
    if (this.#handle === undefined || this.pid === undefined) return;
    try {
      this.kill(this.#spawn.killSignal);
    } catch (error) {
      this.#reportError(asChildProcessError(error));
    }
  }

  #onPipeError(error: Error): void {
    const childError = asChildProcessError(error);
    if (this.#spawnEventQueued && !this.#spawnEventEmitted) this.#scheduleError(childError);
    else this.#reportError(childError);
    this.#stopOnPipeFailure();
  }

  #reportError(error: Error): void {
    if (this.#errorEmitted) return;
    this.#errorEmitted = true;
    this.#safeEmit("error", error);
  }

  #scheduleError(error: Error): void {
    if (this.#errorEmitted || this.#errorScheduled) return;
    this.#errorScheduled = true;
    queueMicrotask(() => {
      this.#errorScheduled = false;
      this.#reportError(error);
      this.#emitCloseIfReady();
    });
  }

  #emitCloseIfReady(): void {
    if (
      this.#closeEmitted ||
      !this.#exitSeen ||
      !this.#stdoutClosed ||
      !this.#stderrClosed ||
      !this.#preparedReleased ||
      this.#errorScheduled
    )
      return;
    this.#closeEmitted = true;
    this.#clearTimeout();
    this.#removeAbortListeners();
    if (this.#handle !== undefined) {
      try {
        unwrapHostResult(this.#host.reap(this.#handle), "reap");
      } catch (error) {
        this.#reportError(asChildProcessError(error));
      }
      this.#handle = undefined;
    }
    this.#safeEmit(
      "close",
      this.#statusUnavailable ? null : this.exitCode,
      this.#statusUnavailable ? null : this.signalCode,
    );
  }

  #safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  #clearTimeout(): void {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    this.#timeout = undefined;
  }

  #removeAbortListeners(): void {
    for (const [signal, listener] of this.#abortListeners) {
      signal.removeEventListener("abort", listener);
    }
    this.#abortListeners.clear();
  }
}
