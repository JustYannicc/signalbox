import { allocateAgentOsPipe } from "./process/AgentOsDescriptorPipe.ts";
import {
  AgentOsDescriptorOperations,
  type AgentOsDescriptorImports,
} from "./process/AgentOsDescriptorOperations.ts";
import type { AgentOsDescriptorHostOptions } from "./process/AgentOsDescriptorSupport.ts";

export type { AgentOsDescriptorHostOptions } from "./process/AgentOsDescriptorSupport.ts";

/** AgentOS descriptor imports backed by the process's shared WASI table. */
export class AgentOsDescriptorHost {
  readonly imports: AgentOsDescriptorImports;
  readonly suspendingImports: readonly string[];
  readonly #operations: AgentOsDescriptorOperations;

  constructor(options: AgentOsDescriptorHostOptions) {
    this.#operations = new AgentOsDescriptorOperations(options);
    this.imports = Object.freeze({
      fd_pipe: (readPointer: number, writePointer: number) =>
        allocateAgentOsPipe(options, readPointer, writePointer),
      ...this.#operations.imports,
    });
    this.suspendingImports = this.#operations.suspendingImports;
  }

  getImportObject(): { host_process: Record<string, unknown> } {
    const hostProcess = { ...this.imports } as Record<string, unknown>;
    if (this.suspendingImports.length === 0) return { host_process: hostProcess };

    const wasm = WebAssembly as unknown as {
      Suspending?: new (fn: (...args: number[]) => Promise<number>) => unknown;
    };
    if (typeof wasm.Suspending !== "function") {
      throw new Error("Descriptor imports require WebAssembly JSPI");
    }
    for (const name of this.suspendingImports) {
      hostProcess[name] = new wasm.Suspending(
        hostProcess[name] as (...args: number[]) => Promise<number>,
      );
    }
    return { host_process: hostProcess };
  }
}
