import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCommand, KernelCommandExit } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramImplementation } from "../kernel/KernelProgramHost.ts";
import type { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";

export type ChildWorkerModule = string | { readonly js: string } | { readonly wasm: ArrayBuffer };

export interface ChildWorkerCode {
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, ChildWorkerModule>>;
  readonly entrypoint?: string;
}

export interface ChildWorkerInvocation extends ChildWorkerCode {
  readonly command: KernelCommand;
}

export interface ChildWorkerDispatch<Host extends object> {
  readonly run: (input: ChildWorkerInvocation, host: Host) => Promise<KernelCommandExit>;
}

export interface ChildWorkerProgramOptions<Host extends object> {
  readonly executable: string;
  readonly code: ChildWorkerCode;
  readonly capacity: Pick<ChildWorkerCapacity, "acquire">;
  readonly dispatch: ChildWorkerDispatch<Host>;
  /** The adapter supplies an RPC target; its methods retain the process's actual kernel resources. */
  readonly createHost: (context: KernelAsyncProgramContext) => {
    readonly host: Host;
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
  });
  return Object.freeze({
    kind: "async" as const,
    async run(context: KernelAsyncProgramContext) {
      const permit = await options.capacity.acquire(context.signal);
      try {
        context.signal.throwIfAborted();
        const owner = options.createHost(context);
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
        } finally {
          await owner.close();
        }
      } finally {
        permit.release();
      }
    },
  });
}
