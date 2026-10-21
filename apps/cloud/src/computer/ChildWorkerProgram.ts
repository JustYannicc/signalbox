import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import { ChildHostLease } from "./ChildHostLease.ts";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import {
  isChildWorkerReservation,
  type ChildWorkerCapacity,
  type ChildWorkerReservation,
} from "./ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import { resolveChildWorkerLimits, type ChildWorkerLimits } from "./ChildWorkerLimits.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

export type ChildWorkerModule =
  | string
  | { readonly js: string }
  | { readonly wasm: ArrayBuffer | WebAssembly.Module }
  | { readonly wasmReference: string };

export type ChildWorkerModules = Readonly<Record<string, ChildWorkerModule>>;
export type ChildWorkerModulesFactory = () => ChildWorkerModules | Promise<ChildWorkerModules>;

export interface ChildWorkerCode {
  readonly mainModule: string;
  readonly modules: ChildWorkerModules | ChildWorkerModulesFactory;
  readonly entrypoint?: string;
  readonly limits?: ChildWorkerLimits;
}

export interface ChildWorkerInvocation extends Omit<ChildWorkerCode, "modules"> {
  readonly modules: ChildWorkerModules;
  readonly command: KernelCommand;
}

export interface ChildWorkerDispatch<Host extends object> {
  /** The permit follows this promise, including any descendant continuations in the worker. */
  readonly run: (input: ChildWorkerInvocation, host: Host) => Promise<KernelCommandExit>;
}

export interface ChildWorkerProgramOptions<Host extends object> {
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
  ) => {
    readonly host: Host;
    /** Logical exit may precede dispatch completion when descendants retain the worker. */
    readonly exited?: Promise<KernelCommandExit>;
    readonly close: () => Promise<void> | void;
  };
}

export type ChildWorkerProgram = Extract<
  KernelProgramImplementation,
  { readonly kind: "async" }
> & { readonly drain: () => Promise<void> };

/** Keep kernel admission and fd ownership in the facet while the program body runs in a child. */
export function createChildWorkerProgram<Host extends object>(
  options: ChildWorkerProgramOptions<Host>,
): ChildWorkerProgram {
  const {
    executable,
    capacity,
    reservationFor,
    childEnv,
    dispatch,
    createHost,
    code: { mainModule, modules: moduleSource, entrypoint, limits },
  } = options;
  const code = Object.freeze({
    mainModule,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    limits: resolveChildWorkerLimits(limits),
  });
  const loadModules = createModuleLoader(moduleSource);
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  return Object.freeze({
    kind: "async" as const,
    async run(context: KernelAsyncProgramContext) {
      const result = Promise.withResolvers<KernelCommandExit>();
      const work = async () => {
        context.signal.throwIfAborted();
        const modules = await loadModules();
        context.signal.throwIfAborted();
        const env = Object.freeze({
          ...(childEnv === undefined ? context.env : childEnv(context)),
        });
        const lease = new ChildHostLease();
        const owner = createHost(childEnv === undefined ? context : { ...context, env }, lease);
        if (owner.exited !== undefined) void owner.exited.then(result.resolve, result.reject);
        let failure: ChildWorkerDispatchError | undefined;
        try {
          return await dispatch.run(
            Object.freeze({
              ...code,
              modules,
              command: {
                executable,
                argv: [...context.args],
                cwd: context.filesystem.cwd,
                env,
              },
            }),
            owner.host,
          );
        } catch (error) {
          failure =
            error instanceof ChildWorkerDispatchError
              ? error
              : new ChildWorkerDispatchError(error, {
                  kind: "unconfirmed",
                  stopped: new Promise<void>(() => {}),
                });
          result.reject(failure);
        } finally {
          // Late child calls then fail with EBADF instead of reaching a process that is closing.
          lease.release();
          try {
            await owner.close();
          } finally {
            if (failure?.termination.kind === "unconfirmed") {
              // Capability cleanup cannot acknowledge a worker whose transport disappeared.
              await failure.termination.stopped;
            }
          }
        }
        throw failure;
      };
      const lifetime =
        reservationFor === undefined
          ? capacity.run(context.signal, work)
          : runWithReservation(reservationFor, context, work);
      lifetimes.track(lifetime);
      // Logical exit can precede dispatch completion and physical teardown on either admission path.
      void lifetime.then(result.resolve, result.reject);
      return result.promise;
    },
    drain: () => lifetimes.drain(),
  });
}

function runWithReservation<T>(
  reservationFor: (context: KernelAsyncProgramContext) => ChildWorkerReservation,
  context: KernelAsyncProgramContext,
  work: () => Promise<T>,
): Promise<T> {
  const reservation = reservationFor(context);
  if (!isChildWorkerReservation(reservation)) {
    throw new TypeError("Child worker reservation resolver did not return a capacity reservation");
  }
  return reservation.run(context.signal, work);
}

function createModuleLoader(source: ChildWorkerModules | ChildWorkerModulesFactory) {
  if (typeof source === "function") return createFactoryModuleLoader(source);
  return createStaticModuleLoader(captureModules(source));
}

function createFactoryModuleLoader(source: ChildWorkerModulesFactory) {
  return async () => captureModules(await source());
}

function createStaticModuleLoader(modules: ChildWorkerModules) {
  return async () => modules;
}

function captureModules(modules: ChildWorkerModules): ChildWorkerModules {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(modules).map(([name, module]) => [
        name,
        typeof module === "string"
          ? module
          : "wasmReference" in module
            ? Object.freeze({ wasmReference: module.wasmReference })
            : "wasm" in module
              ? Object.freeze({ wasm: module.wasm })
              : Object.freeze({ js: module.js }),
      ]),
    ),
  );
}
