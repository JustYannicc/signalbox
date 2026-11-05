import { RpcTarget } from "cloudflare:workers";
import { retainRpcCapability } from "../rpc/Capability.ts";
import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type { KernelChildRegistration } from "../kernel/KernelChildDispatchPort.ts";
import type {
  ComputerProgramOwnerPort,
  KernelComputerAdmissionCapture,
  KernelComputerAdmissionInput,
} from "../kernel/KernelComputerAdmissionPort.ts";
import type { ChildProgramCodes } from "./ChildProgramCodes.ts";
import type { ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import { createComputerProgramCatalog } from "./ComputerProgramCatalog.ts";
import { ComputerProgramResolver } from "./ComputerProgramResolver.ts";
import { ComputerEscalationTable } from "./EscalationTable.ts";
import type { ComputerEscalationEvidence } from "./EscalationTable.ts";
import { createComputerIsolatePolicy } from "./EscalationPolicy.ts";
import { qualifyComputerProgram } from "./ComputerProgramQualification.ts";
import type {
  ChildWorkerCapacity,
  ChildWorkerAdmissionTicket,
  ChildWorkerReservation,
} from "./ChildWorkerCapacity.ts";
import { ComputerProgramGrant, createComputerOwnerProgram } from "./ComputerProgramGrant.ts";
import type { ComputerOwnerProgram } from "./ComputerProgramGrant.ts";

export interface ComputerProgramOwnerOptions {
  readonly programs: ChildProgramCodes;
  readonly path: readonly string[];
  readonly loader: ChildWorkerLoaderPort;
  readonly capacity: Pick<ChildWorkerCapacity, "enqueue" | "run">;
  readonly rules?: ConstructorParameters<typeof ComputerEscalationTable>[0];
  readonly evidence?: (
    command: KernelComputerAdmissionInput["command"],
    signal: AbortSignal,
  ) => Promise<ComputerEscalationEvidence>;
}

type Binding = {
  readonly manifest: KernelChildRegistration["manifest"];
  readonly implementation: ComputerOwnerProgram;
};

/** Construct inside the Computer DO. Only bounded capabilities lead back to the CLI kernel. */
export class ComputerProgramOwner extends RpcTarget implements ComputerProgramOwnerPort {
  readonly #options;
  readonly #catalog;
  readonly #bindings = new Map<string, Binding>();
  readonly #programs = new Map<string, ComputerOwnerProgram>();
  readonly #resolver;
  readonly #normal;
  readonly #local = new ComputerEscalationTable();
  readonly #pending = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly kernel: KernelComputerAdmissionCapture;
      readonly release: () => void;
      active: boolean;
    }
  >();
  readonly #grants = new Map<string, ComputerProgramGrant>();
  readonly #earlyCancel = new Map<string, unknown>();
  readonly #active = new Set<Promise<unknown>>();
  #closed: Promise<void> | undefined;
  constructor(options: ComputerProgramOwnerOptions) {
    super();
    this.#options = options;
    this.#catalog = createComputerProgramCatalog(options.programs);
    this.#resolver = new ComputerProgramResolver({ path: options.path });
    this.#normal = new ComputerEscalationTable(
      options.rules,
      createComputerIsolatePolicy([...this.#catalog.programs.keys(), "cd"]),
    );
    for (const [path, descriptor] of this.#catalog.programs) {
      let program = this.#programs.get(descriptor.implementation);
      if (program === undefined) {
        program = createComputerOwnerProgram(descriptor, options.capacity, options.loader);
        this.#programs.set(descriptor.implementation, program);
      }
      this.#bindings.set(path, { manifest: descriptor.manifest, implementation: program });
    }
  }
  async registrations() {
    this.#assertOpen();
    return [...this.#catalog.programs.values()].map(registration);
  }
  #assertOpen() {
    if (this.#closed !== undefined)
      throw new KernelProgramExecAdmissionError("ECANCELED", "Computer owner is closed");
  }
  admit(id: string, input: KernelComputerAdmissionInput, kernel: KernelComputerAdmissionCapture) {
    const pending = this.#admit(id, input, kernel);
    this.#active.add(pending);
    return pending.finally(() => this.#active.delete(pending));
  }
  async #admit(
    id: string,
    input: KernelComputerAdmissionInput,
    kernel: KernelComputerAdmissionCapture,
  ) {
    this.#assertOpen();
    if (!id || this.#pending.has(id) || this.#grants.has(id))
      throw new Error("Duplicate Computer admission");
    const capability = retainRpcCapability(kernel);
    kernel = capability.value;
    const release = () => capability[Symbol.dispose]();
    const controller = new AbortController();
    const signal = controller.signal;
    const pending = { controller, kernel, release, active: true };
    this.#pending.set(id, pending);
    if (this.#earlyCancel.has(id)) {
      controller.abort(this.#earlyCancel.get(id));
      this.#earlyCancel.delete(id);
    }
    void kernel.aborted().then(
      (result) => {
        if (result.aborted) controller.abort(result.reason);
        if (!pending.active && this.#pending.delete(id)) release();
      },
      (error: unknown) => controller.abort(error),
    );
    let ticket: ChildWorkerAdmissionTicket | undefined;
    let reservation: ChildWorkerReservation | undefined;
    let transferred = false;
    try {
      signal.throwIfAborted();
      const binding =
        input.target.kind === "resolved" ? this.#bindings.get(input.command.executable) : undefined;
      if (
        input.target.kind === "resolved" &&
        (binding === undefined ||
          binding.manifest.name !== input.target.manifest.name ||
          binding.manifest.version !== input.target.manifest.version ||
          binding.manifest.entrypoint !== input.target.manifest.entrypoint)
      )
        throw new TypeError("Kernel registration differs from Computer catalog");
      const target =
        input.target.kind === "resolved"
          ? { kind: "resolved" as const, binding: binding! }
          : input.target;
      const resolved = await this.#resolver.resolve({
        command: input.command,
        target,
        signal,
        namespace: kernel,
        catalog: this.#bindings,
        aliases: this.#catalog.aliases,
      });
      const evidence = await this.#options.evidence?.(resolved.command, signal);
      const qualified = input.localOnly
        ? undefined
        : await qualifyComputerProgram(
            kernel,
            resolved.catalog?.command ?? resolved.command,
            signal,
          );
      signal.throwIfAborted();
      this.#assertOpen();
      const decision = (input.localOnly ? this.#local : this.#normal).decide(
        resolved.command,
        evidence,
        resolved.catalog?.command,
        qualified,
      );
      if (
        resolved.unavailable !== undefined &&
        !(decision.kind === "machine" && "ruleId" in decision)
      )
        throw new KernelProgramExecAdmissionError(
          resolved.unavailable.code,
          resolved.unavailable.message,
        );
      if (decision.kind === "machine") {
        await kernel.assertForwarding();
        signal.throwIfAborted();
        this.#assertOpen();
        transferred = true;
        return { route: "machine" as const, command: resolved.command };
      }
      const selected = resolved.catalog?.binding ?? binding;
      if (selected === undefined) {
        if (input.target.kind === "unsupported")
          throw new KernelProgramExecAdmissionError(input.target.code, input.target.message);
        throw new TypeError("Resolved program is missing from Computer");
      }
      const requester = await kernel.requester();
      signal.throwIfAborted();
      ticket = this.#options.capacity.enqueue(signal, { owner: requester });
      const prepared = await selected.implementation.runner.prepare();
      signal.throwIfAborted();
      reservation = await ticket.reserve(prepared);
      signal.throwIfAborted();
      this.#assertOpen();
      const grant = new ComputerProgramGrant(
        selected.implementation,
        reservation,
        controller,
        kernel,
        () => {
          this.#grants.delete(id);
          release();
        },
      );
      this.#grants.set(id, grant);
      transferred = true;
      const descriptor = this.#catalog.programs.get(
        resolved.catalog?.command.executable ?? input.command.executable,
      );
      if (descriptor === undefined) throw new TypeError("Computer program descriptor is missing");
      return { route: "child" as const, registration: registration(descriptor), grant };
    } finally {
      pending.active = false;
      if (!transferred || this.#grants.has(id)) this.#pending.delete(id);
      if (!transferred) {
        reservation?.cancel();
        ticket?.cancel();
        release();
      }
    }
  }
  async cancel(id: string, reason?: unknown) {
    const pending = this.#pending.get(id);
    if (pending !== undefined) {
      pending.controller.abort(reason);
      try {
        await pending.kernel.revoke();
      } finally {
        if (!pending.active) {
          this.#pending.delete(id);
          pending.release();
        }
      }
      return;
    }
    const grant = this.#grants.get(id);
    if (grant !== undefined) {
      await grant.cancel(reason);
      return;
    }
    if (this.#earlyCancel.size < 64) this.#earlyCancel.set(id, reason);
  }
  close() {
    return (this.#closed ??= (async () => {
      const reason = new Error("Computer owner closed");
      const pending = [...this.#pending.values()];
      for (const request of pending) request.controller.abort(reason);
      const results = await Promise.allSettled([
        ...pending.map((request) => request.kernel.revoke()),
        ...[...this.#grants.values()].map(async (grant) => {
          await grant.cancel(reason);
          await grant.finished();
        }),
      ]);
      while (this.#active.size > 0) await Promise.allSettled(this.#active);
      const runners = await Promise.allSettled(
        [...this.#programs.values()].map((program) => program.runner.drain()),
      );
      const releases = await Promise.allSettled(
        [...this.#pending.values()].map(async (request) => request.release()),
      );
      this.#pending.clear();
      this.#grants.clear();
      this.#earlyCancel.clear();
      const failures = [...results, ...runners, ...releases].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) throw new AggregateError(failures, "Computer owner cleanup failed");
    })());
  }
}

function registration(
  descriptor: import("./ComputerProgramCatalog.ts").ComputerCatalogProgram,
): KernelChildRegistration {
  return {
    executable: descriptor.executable,
    manifest: descriptor.manifest,
    hostKind: descriptor.hostKind,
    ...(descriptor.sigpipe === undefined ? {} : { sigpipe: descriptor.sigpipe }),
    ...(descriptor.pwd === undefined ? {} : { pwd: descriptor.pwd }),
    ...(descriptor.code.executableArtifact === undefined
      ? {}
      : { artifact: descriptor.code.executableArtifact }),
  };
}
