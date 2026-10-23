import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type {
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "../kernel/KernelProgramAdmission.ts";
import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import type { KernelCommandForwarder } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import {
  type ChildWorkerAdmissionTicket,
  isChildWorkerReservation,
  type ChildWorkerCapacity,
  type ChildWorkerReservation,
  type ChildWorkerSlotRequest,
} from "./ChildWorkerCapacity.ts";
import {
  assertComputerForwardingSupported,
  createComputerForwardedProgram,
} from "./ComputerForwardedProgram.ts";
import type { ComputerEscalationEvidence, ComputerEscalationTable } from "./EscalationTable.ts";

export interface ComputerProgramAdmissionOptions {
  readonly escalation: ComputerEscalationTable;
  readonly capacity: Pick<ChildWorkerCapacity, "enqueue">;
  readonly machine: KernelCommandForwarder;
  readonly evidence?: (
    command: KernelCommand,
    signal: AbortSignal,
  ) => Promise<ComputerEscalationEvidence>;
}

interface AdmissionRecord {
  readonly owner: object;
  readonly generation: number;
  readonly request: KernelProgramAdmissionRequest;
  readonly implementation: KernelProgramImplementation;
  readonly reservation: ChildWorkerReservation;
  bound?: {
    readonly context: KernelAsyncProgramContext;
    readonly cwd: string;
    readonly identity: KernelAsyncProgramContext["identity"];
  };
  state: "available" | "claimed" | "cancelled";
}

/** One resolver belongs to one Computer; its grants cannot cross owners or dispatch generations. */
export function createComputerProgramAdmission(options: ComputerProgramAdmissionOptions) {
  const owner = Object.freeze({});
  const grants = new WeakMap<object, AdmissionRecord>();
  const unused = new Set<AdmissionRecord>();
  let generation = 1;
  let closed = false;
  const reserves = new Set<AbortController>();
  const assertOpen = (expected = generation) => {
    if (closed || expected !== generation) {
      throw new KernelProgramExecAdmissionError("ECANCELED", "Computer admission owner changed");
    }
  };
  const cancel = (record: AdmissionRecord) => {
    if (record.state !== "available") return;
    record.state = "cancelled";
    unused.delete(record);
    record.reservation.cancel();
  };
  return Object.freeze({
    async admit(request: KernelProgramAdmissionRequest): Promise<KernelProgramAdmissionDecision> {
      assertOpen();
      const admittedGeneration = generation;
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal.reason);
      reserves.add(controller);
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();

      let ticket: ChildWorkerAdmissionTicket | undefined;
      let reservation: ChildWorkerReservation | undefined;
      let transferred = false;
      try {
        controller.signal.throwIfAborted();
        const evidencePromise = options.evidence?.(request.command, controller.signal);
        const evidence =
          evidencePromise === undefined
            ? undefined
            : await awaitWithAbort(evidencePromise, controller.signal);
        controller.signal.throwIfAborted();
        assertOpen(admittedGeneration);
        const decision = options.escalation.decide(request.command, evidence);
        if (decision.kind === "machine") {
          assertComputerForwardingSupported(request);
          return Object.freeze({
            kind: "forward" as const,
            implementation: createComputerForwardedProgram(options.machine, request.command),
            assertCurrent: () => {
              assertOpen(admittedGeneration);
              request.signal.throwIfAborted();
              assertComputerForwardingSupported(request);
            },
          });
        }
        if (request.target.kind !== "resolved") {
          throw new KernelProgramExecAdmissionError(request.target.code, request.target.message);
        }
        const implementation = request.target.binding.implementation;
        if (implementation.kind !== "async") {
          throw new KernelProgramExecAdmissionError("ENOTSUP", "Computer requires a child program");
        }
        const prepare = (
          implementation as KernelProgramImplementation & {
            readonly prepare?: () => Promise<ChildWorkerSlotRequest>;
          }
        ).prepare;
        if (typeof prepare !== "function") {
          throw new TypeError("Child worker implementation must prepare its ProcessSlot request");
        }

        // Claim FIFO/nested priority before hashing; this ticket holds no process permit.
        const process = request.kind === "exec" ? request.identity?.handle : request.parent;
        const parent =
          request.kind === "exec" && process === undefined
            ? undefined
            : request.processes.info(process);
        const parentPid =
          parent?.status === "ok"
            ? request.kind === "exec"
              ? parent.value.parentPid
              : parent.value.pid
            : undefined;
        ticket = options.capacity.enqueue(controller.signal, {
          processes: request.processes,
          process,
          ...(parentPid === undefined ? {} : { parentPid }),
        });
        const prepared = await awaitWithAbort(prepare.call(implementation), controller.signal);
        controller.signal.throwIfAborted();
        reservation = await ticket.reserve(prepared);
        if (!isChildWorkerReservation(reservation)) {
          throw new TypeError("Computer capacity did not issue a child worker reservation");
        }
        assertOpen(admittedGeneration);
        controller.signal.throwIfAborted();
        const record: AdmissionRecord = {
          owner,
          generation: admittedGeneration,
          request,
          implementation,
          reservation,
          state: "available",
        };
        const admission = Object.freeze({});
        grants.set(admission, record);
        unused.add(record);
        transferred = true;
        return Object.freeze({
          kind: "local" as const,
          admission,
          assertCurrent: () => {
            assertOpen(admittedGeneration);
            request.signal.throwIfAborted();
            if (record.state !== "available") {
              throw new KernelProgramExecAdmissionError(
                "ECANCELED",
                "Computer grant was cancelled",
              );
            }
          },
          cancel: () => cancel(record),
          onDispatch: (context: KernelAsyncProgramContext) => {
            assertOpen(admittedGeneration);
            if (record.state !== "available" || record.bound !== undefined) {
              throw new TypeError("Computer grant was already bound");
            }
            try {
              validateContext(request, context);
              record.bound = {
                context,
                cwd: context.filesystem.cwd,
                identity: Object.freeze({ ...context.identity }),
              };
            } catch (error) {
              cancel(record);
              throw error;
            }
          },
        });
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        reserves.delete(controller);
        if (!transferred) {
          reservation?.cancel();
          ticket?.cancel();
        }
      }
    },
    reservationFor(
      context: KernelAsyncProgramContext,
      expectedImplementation: KernelProgramImplementation,
    ): ChildWorkerReservation {
      assertOpen();
      const record = context.admission === undefined ? undefined : grants.get(context.admission);
      if (
        record === undefined ||
        record.owner !== owner ||
        record.generation !== generation ||
        record.state !== "available" ||
        record.implementation !== expectedImplementation ||
        record.bound?.context !== context ||
        record.bound.cwd !== context.filesystem.cwd ||
        record.bound.identity.handle !== context.identity.handle ||
        record.bound.identity.pid !== context.identity.pid
      ) {
        if (record !== undefined) cancel(record);
        throw new TypeError("Computer grant does not belong to this program dispatch");
      }
      try {
        validateContext(record.request, context);
        context.signal.throwIfAborted();
      } catch (error) {
        cancel(record);
        throw error;
      }
      record.state = "claimed";
      unused.delete(record);
      return record.reservation;
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      const reason = new KernelProgramExecAdmissionError(
        "ECANCELED",
        "Computer admission owner changed",
      );
      for (const controller of reserves) controller.abort(reason);
      for (const record of unused) cancel(record);
    },
  });
}

function awaitWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function validateContext(
  request: KernelProgramAdmissionRequest,
  context: KernelAsyncProgramContext,
) {
  const command = request.command;
  const envKeys = Object.keys(command.env);
  if (
    context.processes !== request.processes ||
    !context.filesystem.sharesBackingWith(request.filesystem) ||
    (request.kind === "command" && context.filesystem.cwd !== command.cwd) ||
    context.home !== request.home ||
    context.args.length !== command.argv.length ||
    !context.args.every((value, index) => value === command.argv[index]) ||
    envKeys.length !== Object.keys(context.env).length ||
    !envKeys.every((key) => context.env[key] === command.env[key])
  ) {
    throw new TypeError("Computer process context changed after admission");
  }
  if (request.kind === "exec") {
    if (
      request.identity?.handle !== context.identity.handle ||
      request.identity.pid !== context.identity.pid ||
      request.filesystem !== context.filesystem
    ) {
      throw new TypeError("Computer replacement process identity changed");
    }
  } else {
    const parent = request.processes.info(request.parent);
    const process = context.processes.info(context.identity.handle);
    if (
      parent.status !== "ok" ||
      process.status !== "ok" ||
      process.value.parentPid !== parent.value.pid
    ) {
      throw new TypeError("Computer child process owner changed");
    }
  }
}
