import type { CodeModeCellCapacity } from "../codeMode/Capacity.ts";
import { CODE_MODE_HOST_MANIFEST } from "./CodeModeManifest.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import { createKernelProcessStreams } from "../kernel/KernelProcessStreams.ts";
import { runCodeModeHostConnection } from "../codeMode/Connection.ts";
import type { CodeModeCellCode, CodeModeCellLoaderPort } from "../codeMode/Types.ts";

export { runCodeModeHostConnection } from "../codeMode/Connection.ts";
export type { CodeModeConnectionOptions } from "../codeMode/Connection.ts";
export { createCodeModeWorkerLoader, createCodeModeServiceLoader } from "../codeMode/Loader.ts";
export type { CodeModeWorkerPolicy } from "../codeMode/Loader.ts";
export type {
  CodeModeCellCode,
  CodeModeCellCompletion,
  CodeModeCellEvents,
  CodeModeCellInvocation,
  CodeModeCellLoaderPort,
  CodeModeContent,
  CodeModeExecuteRequest,
  CodeModeToolDefinition,
} from "../codeMode/Types.ts";

export { CODE_MODE_HOST_EXECUTABLE, CODE_MODE_UPSTREAM_COMMIT } from "./CodeModeManifest.ts";

/** Register this binding at the exact companion path and seed it through the ordinary filesystem. */
export function createCodeModeHostProgram(options: {
  readonly loader: CodeModeCellLoaderPort;
  /** Separate so a yielded cell cannot hold a command slot. */
  readonly capacity: Pick<CodeModeCellCapacity, "acquire">;
  readonly code: CodeModeCellCode;
}) {
  const code: CodeModeCellCode = Object.freeze({
    mainModule: options.code.mainModule,
    modules: Object.freeze(
      Object.fromEntries(
        Object.entries(options.code.modules).map(([key, value]) => [
          key,
          typeof value === "string" ? value : Object.freeze({ js: value.js }),
        ]),
      ),
    ),
  });
  const lifetimes = new Set<Promise<unknown>>();
  const errors: unknown[] = [];
  const binding: KernelProgramBinding = {
    manifest: CODE_MODE_HOST_MANIFEST,
    implementation: {
      kind: "async",
      run(context) {
        const streams = createKernelProcessStreams(context.filesystem, { signal: context.signal });
        const lifetime = runCodeModeHostConnection({
          input: streams.stdin,
          output: streams.stdout,
          signal: context.signal,
          loader: options.loader,
          cellCapacity: options.capacity,
          code,
        }).then(() => ({
          exitCode: 0,
          signal: context.signal.aborted ? 15 : 0,
          coreDumped: false,
        }));
        lifetimes.add(lifetime);
        void lifetime.then(
          () => lifetimes.delete(lifetime),
          (error: unknown) => {
            errors.push(error);
            lifetimes.delete(lifetime);
          },
        );
        return lifetime;
      },
    },
  };
  return {
    binding,
    async drain() {
      while (lifetimes.size > 0) await Promise.allSettled(lifetimes);
      if (errors.length > 0) throw new AggregateError(errors, "CodeMode host cleanup failed");
    },
  };
}
