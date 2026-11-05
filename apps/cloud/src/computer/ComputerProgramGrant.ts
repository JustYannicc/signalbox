import { RpcTarget } from "cloudflare:workers";
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
    const kernel = process as KernelChildDispatchPort & Partial<KernelBashProcessDispatch>;
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
      command: description.command,
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
      this.#controller.signal.throwIfAborted();
      if (initial && this.#initialClaimed)
        throw new Error("Initial Bash reservation was already claimed");
      if (initial) this.#initialClaimed = true;
      const description = await phase.describe();
      void phase.aborted().then(
        (result) => {
          if (result.aborted) this.#controller.abort(result.reason);
        },
        (error: unknown) => this.#controller.abort(error),
      );
      const exit = await this.#program.runner.run(
        {
          signal: this.#controller.signal,
          command: description.command,
          requester: { owner: description.requester },
          ...(initial ? { reservation: () => this.#reservation } : {}),
          lifetime: (pending) => this.#track(pending),
          open: async (lease, execution) => ({
            host: new ComputerObservedBash(
              await phase.open(execution.residentByteLimit, new PhaseExecution(execution)),
              lease,
            ),
            onDispatchFailure: (error) => phase.failure(this.#failure(error)),
            close: () => phase.revoke(),
            onStopped: () => phase.stopped(),
          }),
        },
        residentBytes,
      );
      return { ok: true as const, exit };
    } catch (error) {
      return { ok: false as const, failure: this.#failure(error) };
    }
  }
  cancel(reason?: unknown) {
    return (this.#cancelled ??= (async () => {
      this.#controller.abort(reason ?? new Error("Computer grant cancelled"));
      this.#reservation.cancel();
      await this.#capture?.revoke();
      await this.#process?.cancel?.(reason);
    })());
  }
  finished() {
    return (this.#finished ??= (async () => {
      try {
        await this.#operation?.catch(() => undefined);
        while (this.#lifetimes.size > 0) await Promise.allSettled(this.#lifetimes);
        if (this.#failures.length === 1) throw this.#failures[0];
        if (this.#failures.length > 1)
          throw new AggregateError(this.#failures, "Computer dispatch cleanup failed");
      } finally {
        this.#capture = undefined;
        this.#process = undefined;
        this.#operation = undefined;
        this.#onFinished();
      }
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
