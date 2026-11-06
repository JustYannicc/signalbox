// @effect-diagnostics nodeBuiltinImport:off - Node child streams cross the RPC boundary as Web streams.
import { RpcTarget } from "cloudflare:workers";
import * as NodeStream from "node:stream";
import type { NodeChildProcessHandle } from "../../isolate/NodeChildProcessHandle.ts";
import type { KernelProcessTable, KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import type { KernelHandle } from "../../kernel/KernelAbi.ts";
import { kernelOk, kernelError } from "../../kernel/KernelAbi.ts";
import type { ClaudeCliChild } from "../ClaudeCliKernelPort.ts";
import { normalizeSignal } from "../../isolate/NodeChildProcessCompatibility.ts";

export function createCliProcessLeases(processes: KernelProcessTable) {
  const entries = new Map<
    string,
    {
      pid: number;
      handle: KernelHandle<"process">;
      completion: ReturnType<typeof Promise.withResolvers<KernelExitStatus>>;
      child: NodeChildProcessHandle | undefined;
    }
  >();
  return {
    reserve(count: number) {
      if (!Number.isSafeInteger(count) || count < 0 || count > 64 || entries.size + count > 128)
        throw new RangeError("Invalid CLI process lease count");
      const reserved = [];
      for (let index = 0; index < count; index++) {
        const completion = Promise.withResolvers<KernelExitStatus>();
        let child: NodeChildProcessHandle | undefined;
        const result = processes.spawn(
          undefined,
          () => ({
            completion: completion.promise,
            signal(number) {
              if (number === 0) return kernelOk(undefined);
              if (number !== 9 && number !== 15)
                return kernelError("UNSUPPORTED", "Only terminate and kill are supported");
              if (child === undefined)
                completion.resolve({ exitCode: 0, signal: number, coreDumped: false });
              else child.kill(number);
              return kernelOk(undefined);
            },
          }),
          () => {},
        );
        if (result.status !== "ok")
          throw new Error("Computer could not reserve a CLI child identity", { cause: result });
        const entry = {
          ...result.value,
          completion,
          get child() {
            return child;
          },
          set child(value) {
            child = value;
          },
        };
        entries.set(entry.handle.id, entry);
        reserved.push({ pid: entry.pid, handle: entry.handle });
      }
      return reserved;
    },
    assertAvailable(handle: KernelHandle<"process">) {
      const entry = entries.get(handle.id);
      if (
        entry === undefined ||
        entry.child !== undefined ||
        processes.info(handle).status !== "ok"
      )
        throw new Error("CLI child lease is unavailable or already used");
    },
    bind(handle: KernelHandle<"process">, child: NodeChildProcessHandle) {
      const entry = entries.get(handle.id);
      if (
        entry === undefined ||
        entry.child !== undefined ||
        processes.info(handle).status !== "ok"
      )
        throw new Error("CLI child lease is unavailable or already used");
      entry.child = child;
      return entry.pid;
    },
    async complete(handle: KernelHandle<"process">, status: KernelExitStatus) {
      const entry = entries.get(handle.id);
      if (entry === undefined) return;
      entry.completion.resolve(status);
      const result = await processes.terminateAndReap(handle);
      entries.delete(handle.id);
      if (result.status !== "ok")
        throw new Error("Computer could not retire a CLI child identity", { cause: result });
    },
    async close() {
      const results = await Promise.allSettled(
        [...entries.values()].map(async (entry) => {
          entry.child?.kill(15);
          entry.completion.resolve({ exitCode: 0, signal: 15, coreDumped: false });
          const result = await processes.terminateAndReap(entry.handle);
          if (result.status !== "ok")
            throw new Error("Computer could not close a CLI process lease", { cause: result });
        }),
      );
      entries.clear();
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "CLI process leases could not close");
    },
  };
}

export class NodeChildControl extends RpcTarget {
  readonly #child;
  readonly #leases;
  readonly #lease;
  readonly #remove;
  readonly #admitted;
  readonly #exit;
  readonly #closed;
  readonly #pid;
  #disposing: Promise<void> | undefined;
  constructor(
    child: NodeChildProcessHandle,
    leases: ReturnType<typeof createCliProcessLeases>,
    lease: KernelHandle<"process">,
    remove: () => void,
  ) {
    super();
    this.#child = child;
    this.#leases = leases;
    this.#lease = lease;
    this.#remove = remove;
    this.#pid = leases.bind(lease, child);
    const admitted = Promise.withResolvers<void>();
    const exit = Promise.withResolvers<KernelExitStatus>();
    const closed = Promise.withResolvers<void>();
    this.#admitted = admitted.promise;
    this.#exit = exit.promise;
    this.#closed = closed.promise;
    void this.#admitted.catch(() => undefined);
    void this.#exit.catch(() => undefined);
    child.once("spawn", () => admitted.resolve());
    child.on("error", (cause) => {
      admitted.reject(cause);
      exit.reject(cause);
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      exit.resolve({
        exitCode: code ?? 0,
        signal: signal === null ? 0 : normalizeSignal(signal),
        coreDumped: false,
      });
    });
    child.once("close", () => {
      admitted.reject(new Error("Child closed before admission"));
      exit.resolve({
        exitCode: child.exitCode ?? 0,
        signal: child.signalCode === null ? 0 : normalizeSignal(child.signalCode),
        coreDumped: false,
      });
      closed.resolve();
    });
  }
  admitted() {
    return this.#admitted;
  }
  streams(): ClaudeCliChild {
    return {
      pid: this.#pid,
      handle: this.#lease,
      stdin: this.#child.stdin === null ? undefined : byteSink(this.#child.stdin),
      stdout: this.#child.stdout === null ? undefined : byteStream(this.#child.stdout),
      stderr: this.#child.stderr === null ? undefined : byteStream(this.#child.stderr),
      control: this,
    };
  }
  exited() {
    return this.#exit;
  }
  async signal(signal: number) {
    return this.#child.kill(signal);
  }
  dispose() {
    return (this.#disposing ??= (async () => {
      try {
        if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill(15);
        this.#child.stdin?.destroy();
        this.#child.stdout?.resume();
        this.#child.stderr?.resume();
        await this.#closed;
        const status = await this.#exit.catch(() => ({
          exitCode: 1,
          signal: 0,
          coreDumped: false,
        }));
        await this.#leases.complete(this.#lease, status);
      } finally {
        this.#remove();
      }
    })());
  }
}

/**
 * Workers RPC hands a stream's receiving end ArrayBuffer chunks, which a byte-mode Node writable
 * rejects. The transform only converts them; ending, errors and aborts pass straight through.
 */
function byteSink(stream: NodeStream.Writable): WritableStream<Uint8Array> {
  const bytes = new TransformStream<Uint8Array | ArrayBuffer, Uint8Array>({
    transform: (chunk, controller) =>
      controller.enqueue(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk),
  });
  void bytes.readable.pipeTo(NodeStream.Writable.toWeb(stream)).catch(() => undefined);
  return bytes.writable;
}

function byteStream(stream: NodeStream.Readable): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array)) throw new TypeError("Child output was not bytes");
      controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
