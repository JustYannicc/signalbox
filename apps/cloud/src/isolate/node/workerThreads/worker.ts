import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { NodeWorkerPorts } from "./portRuntime.ts";
import type { NodeWorkerMessage } from "./protocol.ts";
import type {
  NodeWorkerExit,
  NodeWorkerRun,
  NodeWorkerRunEvents,
  NodeWorkerStartRequest,
  NodeWorkerSupervisor,
  NodeWorkerThreadContext,
  NodeWorkerModuleLoader,
} from "./workerProtocol.ts";
import {
  cloneEnvironmentData,
  createThreadModule,
  parseWorkerOptions,
  unsupported,
  type NodeWorkerInstance,
  type NodeWorkerOptions,
} from "./threadModule.ts";

export interface CreateNodeWorkerThreadsOptions {
  readonly supervisor: NodeWorkerSupervisor;
  readonly moduleLoader: NodeWorkerModuleLoader;
  readonly context: NodeWorkerThreadContext;
}

function assertOptions({ supervisor, moduleLoader, context }: CreateNodeWorkerThreadsOptions) {
  if (!supervisor || typeof supervisor.start !== "function")
    throw new TypeError("worker_threads requires a supervisor");
  if (!moduleLoader || typeof moduleLoader.resolve !== "function" || !moduleLoader.reference)
    throw new TypeError("worker_threads requires a verified module loader");
  if (
    !context?.ports ||
    typeof context.allocateThreadId !== "function" ||
    typeof context.output !== "function"
  )
    throw new TypeError("worker_threads requires a process context");
}

export function createNodeWorkerThreads(options: CreateNodeWorkerThreadsOptions) {
  assertOptions(options);
  return createNodeWorkerThreadsWithPorts(options, new NodeWorkerPorts(options.context.ports));
}

export function createNodeWorkerThreadsWithPorts(
  { supervisor, moduleLoader, context }: CreateNodeWorkerThreadsOptions,
  ports: NodeWorkerPorts,
) {
  assertOptions({ supervisor, moduleLoader, context });

  const environmentData = new Map(context.environmentData ?? []);
  const workers = new Set<WorkerFacade>();
  let changed = Promise.withResolvers<void>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  function referencesChanged(): void {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
    ports.referencesChanged();
  }

  class WorkerFacade extends NodeEvents.EventEmitter implements NodeWorkerInstance {
    readonly stdin: NodeStream.Writable | null;
    readonly stdout: NodeStream.PassThrough | null;
    readonly stderr: NodeStream.PassThrough | null;
    #threadId: number;
    readonly #request: NodeWorkerStartRequest;
    readonly #port: ReturnType<NodeWorkerPorts["channel"]>["port1"];
    readonly #runEvents: NodeWorkerRunEvents;
    readonly #onReferenceChange: () => void;
    #startPromise: Promise<NodeWorkerRun> | undefined;
    #stopPromise: Promise<number> | undefined;
    #terminationPromise: Promise<number> | undefined;
    #finishPromise: Promise<void> | undefined;
    #exitCode: number | undefined;
    #terminating = false;
    #exited = false;
    #online = false;

    constructor(filename: string | URL, options?: NodeWorkerOptions) {
      super();
      if (disposed) throw new Error("worker_threads facade is disposed");
      const parsed = parseWorkerOptions(filename, options, moduleLoader, context);
      const clonedEnvironmentData = cloneEnvironmentData(ports, environmentData);
      const id = context.allocateThreadId();
      if (!Number.isInteger(id) || id < 1)
        throw new TypeError("Worker thread id must be a positive integer");
      const channel = ports.channel();
      let input: NodeWorkerMessage;
      try {
        input = ports.encode({ workerData: parsed.workerData, parentPort: channel.port2 }, [
          ...parsed.transferList,
          channel.port2,
        ]);
      } catch (error) {
        channel.port1.close();
        throw error;
      }

      this.#threadId = id;
      this.#port = channel.port1;
      this.#onReferenceChange = referencesChanged;
      this.stdin = parsed.stdin ? this.#createStdin() : null;
      this.stdout = parsed.stdout ? new NodeStream.PassThrough() : null;
      this.stderr = parsed.stderr ? new NodeStream.PassThrough() : null;
      this.#request = {
        graph: moduleLoader.reference,
        entry: parsed.entry,
        owner: context.ports.owner,
        threadId: id,
        input,
        environmentData: clonedEnvironmentData,
        env: parsed.env,
        argv: parsed.argv,
        execArgv: parsed.execArgv,
        name: parsed.name,
        stdin: parsed.stdin,
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        // The host applies these limits or rejects the start before reporting online.
        resourceLimits: parsed.resourceLimits,
      };
      this.#runEvents = {
        online: async () => {
          if (this.#exited || this.#online) return;
          this.#online = true;
          try {
            this.emit("online");
          } catch (error) {
            this.#emitError(error instanceof Error ? error : new Error(String(error)));
          }
        },
        output: async (stream: "stdout" | "stderr", bytes: Uint8Array) => {
          if (this.#exited) return;
          const pipe = stream === "stdout" ? this.stdout : this.stderr;
          if (pipe !== null) pipe.write(bytes);
          else await context.output(stream, bytes);
        },
        error: async (error: Error) => {
          if (!this.#exited) this.#emitError(error);
        },
      };
      this.#port.on("message", this.#forwardMessage);
      this.#port.on("messageerror", this.#forwardMessageError);
      queueMicrotask(() => {
        void this.#ensureStarted().catch(() => undefined);
      });
    }

    postMessage(value: unknown, transferList: readonly object[] = []): void {
      if (this.#terminating || this.#exited) return;
      this.#port.postMessage(value, transferList);
    }

    ref(): this {
      this.#setReferenced(true);
      return this;
    }
    unref(): this {
      this.#setReferenced(false);
      return this;
    }
    hasRef(): boolean {
      return !this.#exited && this.#referenced;
    }
    get threadId(): number {
      return this.#threadId;
    }

    terminate(): Promise<number> {
      if (this.#exitCode !== undefined) return Promise.resolve(this.#exitCode);
      this.#terminating = true;
      if (this.#terminationPromise === undefined) {
        this.#terminationPromise = this.#ensureStarted().then(
          (run) => this.#stopRun(run),
          (error: unknown) => {
            if (this.#exitCode !== undefined) return this.#exitCode;
            throw error;
          },
        );
        void this.#terminationPromise.catch((error: unknown) => this.#recordFailure(error));
      }
      return this.#terminationPromise;
    }

    get blocksDrain(): boolean {
      // A confirmed stop still has to deliver its final output and exit.
      return this.#exited || this.hasRef();
    }

    startCpuProfile = unsupported("Worker.startCpuProfile");
    startHeapProfile = unsupported("Worker.startHeapProfile");
    getHeapSnapshot = unsupported("Worker.getHeapSnapshot");
    cpuUsage = unsupported("Worker.cpuUsage");

    #referenced = true;

    readonly #forwardMessage = (message: unknown) => this.emit("message", message);
    readonly #forwardMessageError = (error: unknown) => this.emit("messageerror", error);

    #setReferenced(referenced: boolean): void {
      if (this.#exited || this.#referenced === referenced) return;
      this.#referenced = referenced;
      if (referenced) this.#port.ref();
      else this.#port.unref();
      this.#onReferenceChange();
    }

    #createStdin(): NodeStream.Writable {
      return new NodeStream.Writable({
        write: (chunk: Buffer | Uint8Array | string, _encoding, callback) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
          void this.#ensureStarted()
            .then((run) => run.writeStdin(bytes))
            .then(
              () => callback(),
              (error: unknown) =>
                callback(error instanceof Error ? error : new Error(String(error))),
            );
        },
        final: (callback) => {
          void this.#ensureStarted()
            .then((run) => run.writeStdin(null))
            .then(
              () => callback(),
              (error: unknown) =>
                callback(error instanceof Error ? error : new Error(String(error))),
            );
        },
      });
    }

    #ensureStarted(): Promise<NodeWorkerRun> {
      if (this.#startPromise !== undefined) return this.#startPromise;
      this.#startPromise = ports
        .drain()
        .then(() => supervisor.start(this.#request, this.#runEvents))
        .then((run) => {
          void this.#watch(run);
          return run;
        })
        .catch((error: unknown) => {
          this.#recordFailure(error);
          this.#emitError(error instanceof Error ? error : new Error(String(error)));
          throw error;
        });
      return this.#startPromise;
    }

    async #watch(run: NodeWorkerRun): Promise<void> {
      try {
        const exit = await run.wait();
        if (exit.stopped !== true)
          throw new Error("Worker supervisor did not acknowledge guest stop");
        await this.#finishExit(exit);
      } catch (error) {
        if (this.#exited) return;
        this.#recordFailure(error);
        this.#emitError(error instanceof Error ? error : new Error(String(error)));
        try {
          await this.#stopRun(run);
        } catch (stopError) {
          this.#recordFailure(stopError);
        }
      }
    }

    #stopRun(run: NodeWorkerRun): Promise<number> {
      if (this.#exitCode !== undefined) return Promise.resolve(this.#exitCode);
      if (this.#stopPromise !== undefined) return this.#stopPromise;
      this.#stopPromise = ports
        .drain()
        .catch((error: unknown) => this.#recordFailure(error))
        .then(() => run.terminate())
        .then(async (exit) => {
          if (exit.stopped !== true)
            throw new Error("Worker terminate did not acknowledge guest stop");
          await this.#finishExit(exit);
          return exit.code;
        });
      void this.#stopPromise.catch((error: unknown) => this.#recordFailure(error));
      return this.#stopPromise;
    }

    async #finishExit(exit: NodeWorkerExit): Promise<void> {
      if (this.#finishPromise !== undefined) return this.#finishPromise;
      this.#exitCode = exit.code;
      this.#threadId = -1;
      this.#exited = true;
      this.#port.off("message", this.#forwardMessage);
      this.#port.off("messageerror", this.#forwardMessageError);
      this.#port.close();
      this.stdin?.destroy();
      this.stdout?.end();
      this.stderr?.end();
      this.#onReferenceChange();
      this.#finishPromise = (async () => {
        try {
          await ports.drain();
        } catch (error) {
          this.#recordFailure(error);
        }
        try {
          this.emit("exit", exit.code);
        } catch (error) {
          this.#recordFailure(error);
        }
        workers.delete(this);
        this.#onReferenceChange();
      })();
      return this.#finishPromise;
    }

    #emitError(error: Error): void {
      try {
        if (!this.emit("error", error)) this.#recordFailure(error);
      } catch (listenerError) {
        this.#recordFailure(listenerError);
      }
    }

    #recordFailure(error: unknown): void {
      rejectFailure(error);
    }
  }

  const failure = Promise.withResolvers<never>();
  const failureWaiters = new Set<(error: unknown) => void>();
  let failureSettled = false;
  let failureError: unknown;
  void failure.promise.catch(() => undefined);
  void ports.failure.catch(rejectFailure);
  function rejectFailure(error: unknown): void {
    if (failureSettled) return;
    failureSettled = true;
    failureError = error;
    failure.reject(error);
    for (const reject of failureWaiters) reject(error);
    failureWaiters.clear();
  }
  function waitFor<T>(operation: Promise<T>): Promise<T> {
    if (failureSettled) {
      void operation.catch(() => undefined);
      return Promise.reject(failureError);
    }
    const result = Promise.withResolvers<T>();
    failureWaiters.add(result.reject);
    void operation.then(
      (value) => {
        failureWaiters.delete(result.reject);
        result.resolve(value);
      },
      (error: unknown) => {
        failureWaiters.delete(result.reject);
        result.reject(error);
      },
    );
    return result.promise;
  }

  const Worker = class extends WorkerFacade {
    constructor(filename: string | URL, options?: NodeWorkerOptions) {
      super(filename, options);
      workers.add(this);
      this.once("exit", () => workers.delete(this));
      referencesChanged();
    }
  };
  const module = createThreadModule(Worker, ports, context, environmentData);

  return {
    module,
    async drain(): Promise<void> {
      for (;;) {
        const nextChange = changed.promise;
        await waitFor(ports.drain());
        if (![...workers].some((worker) => worker.blocksDrain)) return;
        await waitFor(nextChange);
      }
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      const active = [...workers];
      disposePromise = (async () => {
        const results = await Promise.allSettled(active.map((worker) => worker.terminate()));
        let disposeError: unknown;
        try {
          await ports.dispose();
        } catch (error) {
          disposeError = error;
        }
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (disposeError !== undefined) failures.push(disposeError);
        if (failures.length > 0)
          throw new AggregateError(failures, "Worker threads disposal failed");
      })();
      return disposePromise;
    },
    get referenced(): boolean {
      return ports.referenced || [...workers].some((worker) => worker.hasRef());
    },
    failure: failure.promise,
  };
}
