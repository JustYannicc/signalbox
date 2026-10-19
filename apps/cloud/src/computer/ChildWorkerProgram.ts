import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "./ChildWorkerDispatchError.ts";
import { resolveChildWorkerLimits, type ChildWorkerLimits } from "./ChildWorkerLimits.ts";

export type ChildWorkerModule = string | { readonly js: string } | { readonly wasm: ArrayBuffer };

export interface ChildWorkerCode {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, ChildWorkerModule>>;
  readonly entrypoint?: string;
  readonly limits?: ChildWorkerLimits;
}

export interface ChildWorkerInvocation extends ChildWorkerCode {
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
  readonly dispatch: ChildWorkerDispatch<Host>;
  /** The adapter supplies an RPC target; its methods retain the process's actual kernel resources. */
  readonly createHost: (context: KernelAsyncProgramContext) => {
    readonly host: Host;
    /** Logical exit may precede dispatch completion when descendants retain the worker. */
    readonly exited?: Promise<KernelCommandExit>;
    readonly close: () => Promise<void> | void;
  };
}

/** Keep kernel admission and fd ownership in the facet while the program body runs in a child. */
export function createChildWorkerProgram<Host extends object>(
  options: ChildWorkerProgramOptions<Host>,
): Extract<KernelProgramImplementation, { readonly kind: "async" }> {
  const code: ChildWorkerCode = Object.freeze({
    mainModule: options.code.mainModule,
    modules: Object.freeze(
      Object.fromEntries(
        Object.entries(options.code.modules).map(([name, module]) => [
          name,
          typeof module === "string"
            ? module
            : "wasm" in module
              ? Object.freeze({ wasm: module.wasm.slice(0) })
              : Object.freeze({ js: module.js }),
        ]),
      ),
    ),
    ...(options.code.entrypoint === undefined ? {} : { entrypoint: options.code.entrypoint }),
    limits: resolveChildWorkerLimits(options.code.limits),
  });
  return Object.freeze({
    kind: "async" as const,
    async run(context: KernelAsyncProgramContext) {
      const result = Promise.withResolvers<KernelCommandExit>();
      const lifetime = options.capacity.run(context.signal, async () => {
        context.signal.throwIfAborted();
        const owner = options.createHost(context);
        if (owner.exited !== undefined) void owner.exited.then(result.resolve, result.reject);
        let failure: ChildWorkerDispatchError | undefined;
        try {
          return await options.dispatch.run(
            {
              ...code,
              command: {
                executable: options.executable,
                argv: [...context.args],
                cwd: context.filesystem.cwd,
                env: { ...context.env },
              },
            },
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
      });
      // Observe late dispatch/close failures while capacity remains held through physical teardown.
      void lifetime.then(result.resolve, result.reject);
      return result.promise;
    },
  });
}
