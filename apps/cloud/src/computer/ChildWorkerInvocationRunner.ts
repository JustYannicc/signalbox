import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import { copyKernelRpcRecord } from "../kernel/KernelRpcReply.ts";
import { ChildHostLease } from "./ChildHostLease.ts";
import type {
  ChildWorkerCapacity,
  ChildWorkerCapacityRequester,
  ChildWorkerReservation,
  ChildWorkerExecution,
} from "./ChildWorkerCapacity.ts";
import type { ChildWorkerCode, ChildWorkerInvocation } from "./ChildWorkerCode.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import { resolveChildWorkerLimits } from "./ChildWorkerLimits.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
import { createChildWorkerPreparation } from "./ChildWorkerPreparation.ts";

export interface ChildWorkerDispatch<Host extends object> {
  readonly run: (
    input: ChildWorkerInvocation,
    host: Host,
    onMemoryLost?: () => Promise<void>,
  ) => Promise<KernelCommandExit>;
}

export interface ChildWorkerInvocationInput<Host extends object> {
  readonly signal: AbortSignal;
  readonly command: () => KernelCommand;
  readonly requester: ChildWorkerCapacityRequester;
  readonly reservation?: (() => ChildWorkerReservation) | undefined;
  readonly lifetime?: (pending: Promise<unknown>) => void;
  readonly open: (
    lease: ChildHostLease,
    execution: ChildWorkerExecution,
  ) => Promise<{
    readonly host: Host;
    readonly exited?: Promise<KernelCommandExit>;
    readonly onDispatchFailure?: (error: unknown) => Promise<void> | void;
    readonly close: () => Promise<void> | void;
    readonly onStopped?: () => Promise<void> | void;
  }>;
}

/** Computer owns preparation, permits and dispatch lifetimes without borrowing a kernel object. */
export function createChildWorkerInvocationRunner<Host extends object>(options: {
  readonly executable: string;
  readonly code: ChildWorkerCode;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly physicalCapacity?: Pick<ChildWorkerCapacity, "acquire"> | undefined;
  readonly lifetimes?: ChildWorkerLifetimes;
  readonly dispatch: ChildWorkerDispatch<Host>;
}) {
  const {
    executable,
    capacity,
    dispatch,
    code: { mainModule, modules: moduleSource, entrypoint, limits },
  } = options;
  const code = Object.freeze({
    mainModule,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    limits: resolveChildWorkerLimits(limits),
  });
  const preparation = createChildWorkerPreparation({ ...code, modules: moduleSource });
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  return Object.freeze({
    prepare: preparation.prepare,
    async run(input: ChildWorkerInvocationInput<Host>, initialResidentBytes = 0) {
      const result = Promise.withResolvers<KernelCommandExit>();
      let settled = false;
      // Boxed so an unseen rejection with undefined never matches "nothing delivered".
      let delivered: { readonly error: unknown } | undefined;
      const settle = {
        resolve(exit: KernelCommandExit) {
          settled = true;
          result.resolve(exit);
        },
        reject(error: unknown) {
          if (!settled) delivered = { error };
          settled = true;
          result.reject(error);
        },
      };
      const lifetime = (async () => {
        const reservation = input.reservation?.();
        const request = reservation?.request ?? (await preparation.prepare(initialResidentBytes));
        const modules = preparation.claim(request);
        const work = async (execution: ChildWorkerExecution) => {
          input.signal.throwIfAborted();
          const command = input.command();
          const env = Object.isFrozen(command.env)
            ? command.env
            : Object.freeze({ ...command.env });
          const lease = new ChildHostLease((bytes) => execution.observe(bytes));
          const owner = await input.open(lease, execution);
          if (owner.exited !== undefined) void owner.exited.then(settle.resolve, settle.reject);
          let failure: ChildWorkerDispatchError | undefined;
          let dispatched = false;
          let physical: Awaited<ReturnType<ChildWorkerCapacity["acquire"]>> | undefined;
          try {
            input.signal.throwIfAborted();
            physical = await options.physicalCapacity?.acquire(input.signal, undefined);
            input.signal.throwIfAborted();
            dispatched = true;
            return copyKernelRpcRecord(
              await dispatch.run(
                Object.freeze({
                  ...code,
                  loaderId: execution.lease.loaderId,
                  modules,
                  command: {
                    executable,
                    argv: [...command.argv],
                    cwd: command.cwd,
                    env,
                  },
                }),
                owner.host,
                () => execution.lose("memory"),
              ),
            );
          } catch (error) {
            failure =
              error instanceof ChildWorkerDispatchError
                ? error
                : new ChildWorkerDispatchError(
                    error,
                    dispatched
                      ? { kind: "unconfirmed", stopped: new Promise<void>(() => {}) }
                      : { kind: "stopped" },
                  );
            settle.reject(failure);
            await owner.onDispatchFailure?.(failure);
          } finally {
            // Late child calls then fail with EBADF instead of reaching a process that is closing.
            try {
              lease.release();
            } finally {
              try {
                await owner.close();
              } finally {
                if (failure?.termination.kind === "unconfirmed") {
                  // Capability cleanup cannot acknowledge a worker whose transport disappeared.
                  await failure.termination.stopped;
                }
                try {
                  await owner.onStopped?.();
                } finally {
                  await physical?.release();
                }
              }
            }
          }
          throw failure;
        };
        return reservation === undefined
          ? capacity.run(input.signal, work, input.requester, request)
          : reservation.run(input.signal, work, input.requester, request);
      })();
      // Logical exit can precede dispatch completion and physical teardown on either admission path.
      // Drain gets only failures the caller never received; the rest would pin the command's frames.
      const retained = lifetime.then(settle.resolve, (error: unknown) => {
        settle.reject(error);
        const received = delivered !== undefined && delivered.error === error;
        delivered = undefined;
        if (!received) throw error;
      });
      input.lifetime?.(retained);
      lifetimes.track(retained);
      return result.promise;
    },
    drain: () => lifetimes.drain(),
  });
}
