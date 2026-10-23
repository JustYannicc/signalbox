import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import { ChildHostLease } from "./ChildHostLease.ts";
import {
  isChildWorkerReservation,
  type ChildWorkerCapacity,
  type ChildWorkerReservation,
  type ChildWorkerExecution,
  type ChildWorkerSlotRequest,
} from "./ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import { resolveChildWorkerLimits } from "./ChildWorkerLimits.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";
import { createChildWorkerPreparation } from "./ChildWorkerPreparation.ts";

import type { ChildWorkerCode, ChildWorkerInvocation } from "./ChildWorkerCode.ts";
export type {
  ChildWorkerModule,
  ChildWorkerModules,
  ChildWorkerModulesFactory,
  ChildWorkerCode,
  ChildWorkerInvocation,
} from "./ChildWorkerCode.ts";

export interface ChildWorkerDispatch<Host extends object> {
  /** The permit follows this promise, including any descendant continuations in the worker. */
  readonly run: (
    input: ChildWorkerInvocation,
    host: Host,
    onMemoryLost?: () => Promise<void>,
  ) => Promise<KernelCommandExit>;
}

export interface ChildWorkerProgramOptions<Host extends object> {
  readonly sigpipe?: KernelProgramImplementation["sigpipe"];
  readonly executable: string;
  readonly code: ChildWorkerCode;
  readonly capacity: Pick<ChildWorkerCapacity, "run">;
  readonly reservationFor?: (context: KernelAsyncProgramContext) => ChildWorkerReservation;
  /** Derive child-only environment values after the original context has claimed admission. */
  readonly childEnv?: (context: KernelAsyncProgramContext) => Readonly<Record<string, string>>;
  readonly lifetimes?: ChildWorkerLifetimes;
  readonly dispatch: ChildWorkerDispatch<Host>;
  /**
   * The adapter supplies an RPC target that reaches kernel resources only through refs held in
   * the lease, which is released before the host closes.
   */
  readonly createHost: (
    context: KernelAsyncProgramContext,
    lease: ChildHostLease,
    execution: ChildWorkerExecution,
  ) => {
    readonly host: Host;
    /** Logical exit may precede dispatch completion when descendants retain the worker. */
    readonly exited?: Promise<KernelCommandExit>;
    /** Preserve a confirmed spawn failure before closure completes the process placeholder. */
    readonly onDispatchFailure?: (error: unknown) => Promise<void> | void;
    readonly close: () => Promise<void> | void;
    readonly onStopped?: () => Promise<void> | void;
  };
}

export type ChildWorkerProgram = Extract<
  KernelProgramImplementation,
  { readonly kind: "async" }
> & {
  readonly prepare: (residentBytes?: number) => Promise<ChildWorkerSlotRequest>;
  readonly drain: () => Promise<void>;
};

/** Keep kernel admission and fd ownership in the facet while the program body runs in a child. */
export function createChildWorkerProgram<Host extends object>(
  options: ChildWorkerProgramOptions<Host>,
): ChildWorkerProgram {
  const runner = createChildWorkerRunner(options);
  return Object.freeze({
    kind: "async" as const,
    ...(options.sigpipe === undefined ? {} : { sigpipe: options.sigpipe }),
    run: (context: KernelAsyncProgramContext) => runner.run(context, options.createHost),
    prepare: runner.prepare,
    drain: runner.drain,
  });
}

/** Fork placement supplies an existing process host while sharing invocation and cleanup rules. */
export function createChildWorkerRunner<Host extends object>(
  options: Omit<ChildWorkerProgramOptions<Host>, "createHost">,
) {
  const {
    executable,
    capacity,
    reservationFor,
    childEnv,
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
    async run(
      context: KernelAsyncProgramContext,
      createHost: ChildWorkerProgramOptions<Host>["createHost"],
      initialResidentBytes = 0,
    ) {
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
        const reservation =
          reservationFor === undefined ? undefined : claimReservation(reservationFor, context);
        const request = reservation?.request ?? (await preparation.prepare(initialResidentBytes));
        const modules = preparation.claim(request);
        const work = async (execution: ChildWorkerExecution) => {
          context.signal.throwIfAborted();
          const env = Object.freeze({
            ...(childEnv === undefined ? context.env : childEnv(context)),
          });
          const lease = new ChildHostLease((bytes) => execution.observe(bytes));
          const owner = createHost(
            childEnv === undefined ? context : { ...context, env },
            lease,
            execution,
          );
          if (owner.exited !== undefined) void owner.exited.then(settle.resolve, settle.reject);
          let failure: ChildWorkerDispatchError | undefined;
          let dispatched = false;
          try {
            context.signal.throwIfAborted();
            dispatched = true;
            return await dispatch.run(
              Object.freeze({
                ...code,
                loaderId: execution.lease.loaderId,
                modules,
                command: {
                  executable,
                  argv: [...context.args],
                  cwd: context.filesystem.cwd,
                  env,
                },
              }),
              owner.host,
              () => execution.lose("memory"),
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
                await owner.onStopped?.();
              }
            }
          }
          throw failure;
        };
        return reservation === undefined
          ? capacity.run(
              context.signal,
              work,
              {
                processes: context.processes,
                process: context.identity.handle,
              },
              request,
            )
          : reservation.run(
              context.signal,
              work,
              {
                processes: context.processes,
                process: context.identity.handle,
              },
              request,
            );
      })();
      // Logical exit can precede dispatch completion and physical teardown on either admission path.
      // Drain gets only failures the caller never received; the rest would pin the command's frames.
      lifetimes.track(
        lifetime.then(settle.resolve, (error: unknown) => {
          settle.reject(error);
          const received = delivered !== undefined && delivered.error === error;
          delivered = undefined;
          if (!received) throw error;
        }),
      );
      return result.promise;
    },
    drain: () => lifetimes.drain(),
  });
}

function claimReservation(
  reservationFor: (context: KernelAsyncProgramContext) => ChildWorkerReservation,
  context: KernelAsyncProgramContext,
): ChildWorkerReservation {
  const reservation = reservationFor(context);
  if (!isChildWorkerReservation(reservation)) {
    throw new TypeError("Child worker reservation resolver did not return a capacity reservation");
  }
  return reservation;
}
