import { RpcTarget } from "cloudflare:workers";
import { retainRpcCapability } from "../rpc/Capability.ts";
import type {
  KernelChildDispatchPort,
  KernelChildHostPort,
} from "../kernel/KernelChildDispatchPort.ts";
import type {
  ComputerProgramGrant as ComputerProgramGrantPort,
  KernelBashProcessDispatch,
  KernelComputerAdmissionCapture,
} from "../kernel/KernelComputerAdmissionPort.ts";
import type {
  KernelBashDispatcher,
  KernelBashPhasePort,
  KernelBashPhaseExecution,
  KernelBashWorkerPort,
} from "../kernel/KernelBashDispatchPort.ts";
import type { KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import { describeKernelWorkerFailure } from "../kernel/KernelWorkerFailure.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import type { ChildWorkerReservation, ChildWorkerExecution } from "./ChildWorkerCapacity.ts";
import { createChildWorkerInvocationRunner } from "./ChildWorkerInvocationRunner.ts";
import { createWorkerLoaderDispatch, type ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import { ComputerObservedChild, ComputerObservedBash } from "./ComputerObservedChild.ts";
import type { ComputerCatalogProgram } from "./ComputerProgramCatalog.ts";
import { ComputerProgramPhase } from "./ComputerProgramPhase.ts";

export interface ComputerOwnerProgram {
  readonly descriptor: ComputerCatalogProgram;
  readonly executableArtifact?: ComputerCatalogProgram["code"]["executableArtifact"];
  readonly runner: ReturnType<
    typeof createChildWorkerInvocationRunner<KernelChildHostPort | KernelBashWorkerPort>
  >;
}

class PhaseExecution extends RpcTarget implements KernelBashPhaseExecution {
  readonly #execution;
  constructor(execution: ChildWorkerExecution) {
    super();
    this.#execution = execution;
  }
  async handoff() {
    await this.#execution.handoff();
  }
}

/** A grant owns one reservation and every continuation dispatch spawned by that process. */
export class ComputerProgramGrant
  extends RpcTarget
  implements ComputerProgramGrantPort, KernelBashDispatcher
{
  readonly #program;
  readonly #onFinished;
  #finished: Promise<void> | undefined;
  readonly #reservation;
  readonly #controller;
  #capture: KernelComputerAdmissionCapture | undefined;
  #process: (KernelChildDispatchPort & Partial<KernelBashProcessDispatch>) | undefined;
  readonly #lifetimes = new Set<Promise<unknown>>();
  readonly #failures: unknown[] = [];
  readonly #capabilities: Disposable[] = [];
  #used = false;
  #cancelled: Promise<void> | undefined;
  #operation: Promise<KernelCommandExit> | undefined;
  #initialClaimed = false;
  constructor(
    program: ComputerOwnerProgram,
    reservation: ChildWorkerReservation,
    controller: AbortController,
    capture: KernelComputerAdmissionCapture,
    onFinished: () => void,
  ) {
    super();
    this.#program = program;
    this.#reservation = reservation;
    this.#controller = controller;
    this.#capture = capture;
    this.#onFinished = onFinished;
  }
  #track(lifetime: Promise<unknown>) {
    this.#lifetimes.add(lifetime);
    void lifetime.then(
      () => this.#lifetimes.delete(lifetime),
      (error: unknown) => {
        this.#lifetimes.delete(lifetime);
        this.#failures.push(error);
      },
    );
  }
  async run(process: KernelChildDispatchPort): ReturnType<ComputerProgramGrantPort["run"]>;
  async run(
    phase: KernelBashPhasePort,
    initial: boolean,
    residentBytes: number,
  ): ReturnType<KernelBashDispatcher["run"]>;
  async run(
    process: KernelChildDispatchPort | KernelBashPhasePort,
    initial?: boolean,
    residentBytes = 0,
  ) {
    if (initial !== undefined)
      return await this.#runBashPhase(process as KernelBashPhasePort, initial, residentBytes);
    if (this.#used) throw new Error("Computer grant was already dispatched");
    this.#used = true;
    const capability = retainRpcCapability(process);
    this.#capabilities.push(capability);
    const kernel = capability.value as KernelChildDispatchPort & Partial<KernelBashProcessDispatch>;
    this.#process = kernel;
    this.#operation = this.#execute(kernel);
    try {
      return { ok: true as const, exit: await this.#operation };
    } catch (error) {
      return { ok: false as const, failure: this.#failure(error) };
    }
  }
  #failure(error: unknown) {
    const failure = describeKernelWorkerFailure(error);
    return error instanceof ChildWorkerDispatchError ? failure : { ...failure, confirmed: true };
  }
  async #execute(process: KernelChildDispatchPort & Partial<KernelBashProcessDispatch>) {
    this.#controller.signal.throwIfAborted();
    void process.aborted().then(
      (result) => {
        if (result.aborted) this.#controller.abort(result.reason);
      },
      (error: unknown) => this.#controller.abort(error),
    );
    if (this.#program.descriptor.hostKind === "bash") {
      if (process.bash === undefined || process.finished === undefined)
        throw new Error("Kernel Bash continuation capability is missing");
      const exited = process.bash(this);
      this.#track(process.finished());
      return await exited;
    }
    const description = await process.describe();
    this.#controller.signal.throwIfAborted();
    return await this.#program.runner.run({
      signal: this.#controller.signal,
      command: () => description.command,
      requester: { owner: description.requester },
      reservation: () => this.#reservation,
      lifetime: (pending) => this.#track(pending),
      open: async (lease) => ({
        host: new ComputerObservedChild(await process.open(), lease),
        close: () => process.close(),
      }),
    });
  }
  async #runBashPhase(phase: KernelBashPhasePort, initial: boolean, residentBytes: number) {
    try {
      const owner = new ComputerProgramPhase(phase, (reason) => this.#controller.abort(reason));
      let tracked = false;
      try {
        this.#controller.signal.throwIfAborted();
        if (initial && this.#initialClaimed)
          throw new Error("Initial Bash reservation was already claimed");
        if (initial) this.#initialClaimed = true;
        const description = await owner.port.describe();
        const exit = await this.#program.runner.run(
          {
            signal: this.#controller.signal,
            command: () => description.command,
            requester: { owner: description.requester },
            ...(initial ? { reservation: () => this.#reservation } : {}),
            lifetime: (pending) => {
              tracked = true;
              this.#track(owner.after(pending));
            },
            open: async (lease, execution) => ({
              host: new ComputerObservedBash(
                await owner.port.open(execution.residentByteLimit, new PhaseExecution(execution)),
                lease,
              ),
              onDispatchFailure: (error) => owner.port.failure(this.#failure(error)),
              close: () => owner.revoke(),
              onStopped: () => owner.stopped(),
            }),
          },
          residentBytes,
        );
        return { ok: true as const, exit };
      } finally {
        if (!tracked) await owner.close();
      }
    } catch (error) {
      return { ok: false as const, failure: this.#failure(error) };
    }
  }
  cancel(reason?: unknown) {
    return (this.#cancelled ??= (async () => {
      const undelivered = !this.#used;
      if (undelivered) this.#used = true;
      try {
        this.#controller.abort(reason ?? new Error("Computer grant cancelled"));
        this.#reservation.cancel();
        await this.#capture?.revoke();
        await this.#process?.cancel?.(reason);
      } finally {
        // Dispatched work owns its physical stop acknowledgement and calls finished separately.
        if (undelivered) await this.finished();
      }
    })());
  }
  finished() {
    return (this.#finished ??= (async () => {
      const failures: unknown[] = [];
      try {
        await this.#operation?.catch(() => undefined);
        while (this.#lifetimes.size > 0) await Promise.allSettled(this.#lifetimes);
        failures.push(...this.#failures);
      } finally {
        this.#capture = undefined;
        this.#process = undefined;
        this.#operation = undefined;
        for (const capability of this.#capabilities.splice(0).toReversed()) {
          try {
            capability[Symbol.dispose]();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          this.#onFinished();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Computer dispatch cleanup failed");
    })());
  }
}

export function createComputerOwnerProgram(
  descriptor: ComputerCatalogProgram,
  capacity: Parameters<typeof createChildWorkerInvocationRunner>[0]["capacity"],
  loader: ChildWorkerLoaderPort,
) {
  return {
    descriptor,
    ...(descriptor.code.executableArtifact === undefined
      ? {}
      : { executableArtifact: descriptor.code.executableArtifact }),
    runner: createChildWorkerInvocationRunner({
      executable: descriptor.implementation,
      code: descriptor.code,
      capacity,
      dispatch: createWorkerLoaderDispatch<KernelChildHostPort | KernelBashWorkerPort>(loader),
    }),
  } satisfies ComputerOwnerProgram;
}
