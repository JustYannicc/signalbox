// @effect-diagnostics cryptoRandomUUID:off nodeBuiltinImport:off globalTimers:off - The guest API uses Node streams and timeout semantics.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeStreamWeb from "node:stream/web";
import type { ClaudeCliKernelPort, ClaudeCliChild } from "../ClaudeCliKernelPort.ts";
import type { NodeChildProcessSpawn } from "../../isolate/NodeChildProcess.ts";
import { normalizeSignal, signalName } from "../../isolate/NodeChildProcessCompatibility.ts";
import { abortError, asChildProcessError } from "../../isolate/NodeChildProcessCompatibility.ts";
import { unsupportedNodeOperation } from "../../isolate/NodeChildProcessCompatibility.ts";
import { releaseRpcResult, rpcStubOwner } from "../../rpc/Resources.ts";

/** The EventEmitter and streams live in the CLI. Admission, PID and completion belong to Computer. */
export class RemoteNodeChild extends NodeEvents.EventEmitter {
  readonly stdin;
  readonly stdout;
  readonly stderr;
  readonly stdio;
  readonly spawnfile;
  readonly spawnargs;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  timedOut = false;
  connected = false;
  #remote: ClaudeCliChild | undefined;
  #exited = false;
  readonly #id = crypto.randomUUID();
  readonly #lease;
  readonly #kernel;
  readonly #spawn;
  readonly #barrier;
  readonly #release;
  readonly #writeDescriptor;
  readonly #refresh;
  readonly #signal;
  readonly #pumps: Promise<void>[] = [];
  readonly #outputs: (readonly [NodeStream.Readable, NodeStream.Writable])[] = [];
  readonly #abort = new AbortController();
  #signals = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #killed: number | undefined;
  #error: Error | undefined;
  #closed = false;

  constructor(options: {
    readonly kernel: ClaudeCliKernelPort;
    readonly lease: {
      readonly pid: number;
      readonly handle: import("../../kernel/KernelAbi.ts").KernelHandle<"process">;
    };
    readonly spawn: NodeChildProcessSpawn;
    readonly signal: AbortSignal;
    /** Lets Computer close the descriptors this child inherits, once it no longer needs them. */
    readonly release: () => void;
    /** Writes to one of those descriptors, though the CLI may have closed its own copy. */
    readonly writeDescriptor: (fd: number, bytes: Uint8Array) => Promise<void>;
    readonly barrier: () => Promise<void>;
    readonly refresh: (remoteStarted: boolean, submitted: boolean) => Promise<void>;
  }) {
    super();
    this.#kernel = options.kernel;
    this.#spawn = options.spawn;
    this.#lease = options.lease;
    this.pid = options.lease.pid;
    this.#barrier = options.barrier;
    this.#release = options.release;
    this.#writeDescriptor = options.writeDescriptor;
    this.#refresh = options.refresh;
    this.#signal =
      options.spawn.signal === undefined
        ? options.signal
        : AbortSignal.any([options.signal, options.spawn.signal]);
    this.spawnfile = options.spawn.spawnfile;
    this.spawnargs = [...options.spawn.argv];
    this.stdin = options.spawn.stdio[0] === "pipe" ? new NodeStream.PassThrough() : null;
    this.stdout = options.spawn.stdio[1] === "pipe" ? new NodeStream.PassThrough() : null;
    this.stderr = options.spawn.stdio[2] === "pipe" ? new NodeStream.PassThrough() : null;
    this.stdio = [
      this.stdin,
      this.stdout,
      this.stderr,
      ...options.spawn.stdio.slice(3).map(() => null),
    ] as const;
    for (const stream of this.stdio)
      stream?.on("error", (cause) => {
        if (stream === this.stdin && this.#exited && closedInput(cause)) return;
        this.#report(cause);
        if (!this.#exited) this.kill(15);
      });
  }
  get processHandle() {
    return this.#closed ? undefined : this.#lease.handle;
  }
  start() {
    const abort = () => {
      if (this.#exited) return;
      this.#report(abortError());
      void this.#kernel.cancel(this.#id, this.#signal.reason).catch((cause) => this.#report(cause));
      this.kill(this.#spawn.killSignal);
    };
    this.#signal.addEventListener("abort", abort, { once: true });
    if (this.#signal.aborted) abort();
    void this.#run().finally(() => this.#signal.removeEventListener("abort", abort));
  }
  kill(signal?: string | number) {
    if (this.#exited || this.#closed) return false;
    const number = normalizeSignal(signal);
    if (number !== 0 && number !== 9 && number !== 15)
      return unsupportedNodeOperation("child_process signal");
    this.killed = number !== 0;
    if (number !== 0) this.#killed ??= number;
    this.#signals = this.#signals.then(async () => {
      if (this.#remote !== undefined) await this.#remote.control.signal(number);
      else if (number !== 0) await this.#kernel.cancel(this.#id, abortError());
    });
    void this.#signals.catch((cause) => this.#report(cause));
    return true;
  }
  send(..._args: unknown[]): never {
    return unsupportedNodeOperation("child_process IPC");
  }
  disconnect(): never {
    return unsupportedNodeOperation("child_process IPC");
  }
  #report(cause: unknown) {
    if (this.#error !== undefined) return;
    this.#error = asChildProcessError(cause);
    queueMicrotask(() => this.emit("error", this.#error));
  }
  async #run() {
    let remoteStarted = false;
    let submitted = false;
    let step: Step = "barrier";
    try {
      this.#signal.throwIfAborted();
      await this.#barrier();
      remoteStarted = true;
      this.#signal.throwIfAborted();
      const { signal: _signal, ...spawn } = this.#spawn;
      submitted = true;
      step = "spawn";
      this.#remote = await this.#kernel.spawn(this.#id, this.#lease.handle, spawn);
      step = "running";
      this.pid = this.#remote.pid;
      if (this.#signal.aborted) this.kill(this.#spawn.killSignal);
      this.#connect(this.#remote);
      this.emit("spawn");
      if (this.#spawn.timeout > 0)
        this.#timer = setTimeout(() => {
          this.timedOut = true;
          this.kill(this.#spawn.killSignal);
        }, this.#spawn.timeout);
      const exit = await this.#remote.control.exited();
      this.#exited = true;
      this.exitCode = exit.signal === 0 ? exit.exitCode : null;
      this.signalCode = signalName(exit.signal);
      this.stdin?.end();
      this.emit("exit", this.exitCode, this.signalCode);
      await Promise.all(this.#pumps.slice(this.stdin === null ? 0 : 1));
    } catch (cause) {
      await this.#settle(step, cause);
    } finally {
      this.#exited = true;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#abort.abort();
      try {
        await this.#signals;
        await Promise.allSettled(this.#pumps);
        if (this.#remote !== undefined) {
          using _control = rpcStubOwner(this.#remote.control);
          await this.#remote.control.dispose();
        }
      } catch (cause) {
        this.#report(cause);
      } finally {
        if (this.#remote !== undefined) releaseRpcResult(this.#remote);
        this.#remote = undefined;
        this.stdout?.end();
        this.stderr?.end();
        const closed = [this.stdout, this.stderr]
          .filter((stream) => stream !== null)
          .map(
            (stream) =>
              new Promise<void>((resolve) => {
                if (stream.closed) resolve();
                else stream.once("close", resolve);
                stream.resume();
              }),
          );
        await Promise.all(closed);
        this.#release();
        {
          try {
            await this.#refresh(remoteStarted, submitted);
          } catch (cause) {
            this.#report(cause);
          }
        }
        this.#closed = true;
        this.emit("close", this.exitCode, this.signalCode);
      }
    }
  }
  /**
   * How a child that didn't exit normally ends, by the step that failed rather than the error's
   * shape. After its exit, an output error is an `error`. A kill or abort ends it by its signal.
   * A program Computer can't find or run at spawn is Node's own spawn `error`, with the negative
   * errno as its exit code. Anything else exits as on Linux, with its error on stderr: 126 when
   * the child never started, 1 when it did.
   */
  async #settle(step: Step, cause: unknown) {
    if (this.#exited) {
      this.#report(cause);
      this.#discard();
      return;
    }
    // Computer may refuse a cancelled spawn with any error, as it comes over RPC.
    if (this.#killed !== undefined || this.#signal.aborted) {
      this.#discard();
      this.#exited = true;
      this.exitCode = null;
      this.signalCode = signalName(this.#killed ?? normalizeSignal(this.#spawn.killSignal));
      this.emit("exit", null, this.signalCode);
      return;
    }
    const errno = step === "spawn" ? spawnErrno(cause) : undefined;
    if (errno !== undefined) {
      this.#report(cause);
      this.#discard();
      this.exitCode = -errno;
      return;
    }
    await this.#fail(cause, step === "running");
  }
  #discard() {
    this.stdin?.destroy();
    this.stdout?.destroy();
    this.stderr?.destroy();
  }
  async #fail(cause: unknown, started: boolean) {
    this.stdin?.destroy();
    // Computer's output streams may never end now; what reached the CLI stays, nothing more comes.
    for (const [source, target] of this.#outputs) {
      source.unpipe(target);
      source.destroy();
    }
    this.stdout?.end();
    const text = `${this.spawnfile}: ${asChildProcessError(cause).message}\n`;
    const target = this.#spawn.stdio[2];
    if (this.stderr !== null) this.stderr.end(text);
    // A file or the CLI's own stderr, as the Bash tool's output file is: the error goes there.
    else if (typeof target === "number")
      await this.#writeDescriptor(target, new TextEncoder().encode(text)).catch(() => undefined);
    this.#exited = true;
    this.exitCode = started ? 1 : 126;
    this.signalCode = null;
    this.emit("exit", this.exitCode, null);
  }
  #connect(remote: ClaudeCliChild) {
    if (this.stdin !== null && remote.stdin !== undefined) {
      const readable = NodeStream.Readable.toWeb(this.stdin) as ReadableStream<Uint8Array>;
      this.#pumps.push(
        readable.pipeTo(remote.stdin, { signal: this.#abort.signal, preventCancel: true }),
      );
    }
    for (const [source, target] of [
      [remote.stdout, this.stdout],
      [remote.stderr, this.stderr],
    ] as const) {
      if (source === undefined || target === null) continue;
      // A byte-mode Node stream rejects ArrayBuffer chunks, which an RPC stream may deliver.
      const bytes = source.pipeThrough(
        new TransformStream<Uint8Array | ArrayBuffer, Uint8Array>({
          transform: (chunk, controller) =>
            controller.enqueue(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk),
        }),
      );
      const stream = NodeStream.Readable.fromWeb(bytes as NodeStreamWeb.ReadableStream<Uint8Array>);
      const complete = new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        target.on("error", reject);
        target.once("finish", resolve);
        // A failed child destroys its outputs, which then close without finishing. Waiting for
        // `finish` would hold the child's filesystem bracket, and the CLI's view, open forever.
        target.once("close", resolve);
      });
      stream.pipe(target);
      this.#outputs.push([stream, target]);
      this.#pumps.push(complete);
    }
    for (const [index, pump] of this.#pumps.entries())
      void pump.catch((cause) => {
        if (index === 0 && this.stdin !== null && this.#exited && closedInput(cause)) return;
        if (!this.#abort.signal.aborted) this.#report(cause);
      });
  }
}

/** Where a child was when it failed: reaching Computer, being spawned there, or running. */
type Step = "barrier" | "spawn" | "running";

/** The programs Node itself reports as a spawn `error`: one it can't find, or can't run. */
const SPAWN_ERRNO: Readonly<Record<string, number>> = { ENOENT: 2, EACCES: 13 };

const codeOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;

const spawnErrno = (cause: unknown) => {
  const code = codeOf(cause);
  return code === undefined ? undefined : SPAWN_ERRNO[code];
};

function closedInput(cause: unknown) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (("name" in cause && cause.name === "AbortError") ||
      ("code" in cause &&
        ["ABORT_ERR", "EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE"].includes(
          String(cause.code),
        )))
  );
}
