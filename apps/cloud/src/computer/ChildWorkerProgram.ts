import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import { createKernelProcessAdmissionPort } from "../kernel/KernelProcessAdmissionPort.ts";
import type { KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import type { ChildHostLease } from "./ChildHostLease.ts";
import {
  createChildWorkerInvocationRunner,
  type ChildWorkerDispatch,
} from "./ChildWorkerInvocationRunner.ts";
import {
  isChildWorkerReservation,
  type ChildWorkerCapacity,
  type ChildWorkerReservation,
  type ChildWorkerExecution,
  type ChildWorkerSlotRequest,
} from "./ChildWorkerCapacity.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

import type { ChildWorkerCode } from "./ChildWorkerCode.ts";
export type {
  ChildWorkerModule,
  ChildWorkerModules,
  ChildWorkerModulesFactory,
  ChildWorkerCode,
  ChildWorkerInvocation,
} from "./ChildWorkerCode.ts";

export type { ChildWorkerDispatch } from "./ChildWorkerInvocationRunner.ts";
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
  readonly executableArtifact?: ChildWorkerCode["executableArtifact"];
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
    ...(options.code.executableArtifact === undefined
      ? {}
      : { executableArtifact: options.code.executableArtifact }),
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
  const runner = createChildWorkerInvocationRunner(options);
  return Object.freeze({
    prepare: runner.prepare,
    run(
      context: KernelAsyncProgramContext,
      createHost: ChildWorkerProgramOptions<Host>["createHost"],
      initialResidentBytes = 0,
    ) {
      let childContext = context;
      const owner = createKernelProcessAdmissionPort({
        processes: context.processes,
        process: context.identity.handle,
        signal: context.signal,
      });
      return runner.run(
        {
          signal: context.signal,
          command: () => {
            if (options.childEnv !== undefined)
              childContext = { ...context, env: Object.freeze({ ...options.childEnv(context) }) };
            return {
              executable: options.executable,
              argv: context.args,
              cwd: context.filesystem.cwd,
              env: childContext.env,
            };
          },
          requester: { owner },
          lifetime: (pending) => {
            void pending.then(
              () => owner.close(),
              () => owner.close(),
            );
          },
          reservation:
            options.reservationFor === undefined
              ? undefined
              : () => claimReservation(options.reservationFor!, context),
          open: async (lease, execution) => createHost(childContext, lease, execution),
        },
        initialResidentBytes,
      );
    },
    drain: runner.drain,
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
