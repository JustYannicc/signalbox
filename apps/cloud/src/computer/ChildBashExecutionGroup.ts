import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelBashForkHost } from "../kernel/KernelBashHost.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelExitStatus } from "../kernel/KernelProcessTable.ts";
import { BashWorkerPhase } from "./BashWorkerPhase.ts";
import type { createChildWorkerRunner } from "./ChildWorkerProgram.ts";
import { createWorkerBashForkHost } from "./WorkerBashHost.ts";

type Runner = ReturnType<typeof createChildWorkerRunner<KernelBashPort>>;

/** Logical process ownership outlives each stopped Worker invocation and its slot. */
export class ChildBashExecutionGroup {
  readonly #initial: Runner;
  readonly #continued: Runner;
  readonly #credentials: KernelBashCredentials;
  readonly #tasks = new Set<Promise<unknown>>();
  readonly #stops = new Set<Promise<void>>();
  readonly #failures = new Set<unknown>();

  constructor(initial: Runner, continued: Runner, credentials: KernelBashCredentials) {
    this.#initial = initial;
    this.#continued = continued;
    this.#credentials = credentials;
  }

  run(
    context: KernelAsyncProgramContext,
    owner: KernelBashForkHost,
    source?: KernelBashForkSource,
    initial = false,
  ): Promise<KernelExitStatus> {
    return this.#track(async () => {
      try {
        return await this.#execute(context, owner, source, initial);
      } catch (error) {
        await owner.close();
        throw error;
      }
    });
  }

  async finish(close: () => Promise<void>): Promise<void> {
    try {
      while (this.#tasks.size > 0) await Promise.allSettled(this.#tasks);
      while (this.#stops.size > 0) await Promise.allSettled(this.#stops);
    } finally {
      await close();
    }
    if (this.#failures.size === 1) throw this.#failures.values().next().value;
    if (this.#failures.size > 1)
      throw new AggregateError(this.#failures, "Bash continuation failed");
  }

  async #execute(
    context: KernelAsyncProgramContext,
    owner: KernelBashForkHost,
    source: KernelBashForkSource | undefined,
    initial: boolean,
  ): Promise<KernelExitStatus> {
    for (;;) {
      context.signal.throwIfAborted();
      const phase = new BashWorkerPhase({
        filesystem: context.filesystem,
        rootPid: context.identity.pid,
        startFork: (work) => {
          this.#track(work);
        },
      });
      const residentBytes = source === undefined ? 0 : (await source.state()).memoryBytes;
      const runner = initial ? this.#initial : this.#continued;
      initial = false;
      const exit = await runner.run(
        context,
        (admitted, lease, execution) => {
          const stopped = Promise.withResolvers<void>();
          this.#stops.add(stopped.promise);
          void stopped.promise.then(
            () => this.#stops.delete(stopped.promise),
            (error: unknown) => {
              this.#failures.add(error);
              this.#stops.delete(stopped.promise);
            },
          );
          const bridge = createWorkerBashForkHost(
            { context: admitted, credentials: this.#credentials },
            lease,
            owner,
            source,
            phase,
            execution.residentByteLimit,
          );
          return {
            host: bridge.host,
            // The group keeps the kernel process and its descriptors through parked phases.
            close() {},
            async onStopped() {
              try {
                await phase.stopped(execution);
                stopped.resolve();
              } catch (error) {
                stopped.reject(error);
                throw error;
              }
            },
          };
        },
        residentBytes,
      );
      const parked = phase.root;
      if (exit.signal !== 0) {
        await parked?.checkpoint.close();
        await owner.close();
        return exit;
      }
      if (parked === undefined) {
        await owner.port.complete({ kind: "exit", status: exit });
        return exit;
      }
      source = await parked.resume();
    }
  }

  #track<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work);
    this.#tasks.add(pending);
    void pending.then(
      () => this.#tasks.delete(pending),
      (error: unknown) => {
        this.#failures.add(error);
        this.#tasks.delete(pending);
      },
    );
    return pending;
  }
}
