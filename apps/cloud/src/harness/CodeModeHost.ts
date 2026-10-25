import type { ChildWorkerCapacity } from "../computer/ChildWorkerCapacity.ts";
import { ABI_VERSION } from "../kernel/KernelAbi.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import { createKernelProcessStreams } from "../kernel/KernelProcessStreams.ts";
import { runCodeModeHostConnection } from "./codeMode/connection.ts";
import type { CodeModeCellCode, CodeModeCellLoaderPort } from "./codeMode/types.ts";

export { runCodeModeHostConnection } from "./codeMode/connection.ts";
export type { CodeModeConnectionOptions } from "./codeMode/connection.ts";
export { createCodeModeWorkerLoader, createCodeModeServiceLoader } from "./codeMode/loader.ts";
export type { CodeModeWorkerPolicy } from "./codeMode/loader.ts";
export type {
  CodeModeCellCode,
  CodeModeCellCompletion,
  CodeModeCellEvents,
  CodeModeCellInvocation,
  CodeModeCellLoaderPort,
  CodeModeContent,
  CodeModeExecuteRequest,
  CodeModeToolDefinition,
} from "./codeMode/types.ts";

export const CODE_MODE_HOST_EXECUTABLE = "/bin/codex-code-mode-host";
export const CODE_MODE_UPSTREAM_COMMIT = "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d";

/** Register this binding at the exact companion path and seed it through the ordinary filesystem. */
export function createCodeModeHostProgram(options: {
  readonly loader: CodeModeCellLoaderPort;
  /** Separate so a yielded cell cannot hold a command slot. */
  readonly capacity: Pick<ChildWorkerCapacity, "acquire">;
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
    manifest: Object.freeze({
      name: "@signalbox/codex-code-mode-host",
      version: "0.162.1-workerd-port.1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: Object.freeze([]),
      entrypoint: `codex-code-mode-v1:${CODE_MODE_UPSTREAM_COMMIT}`,
    }),
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
