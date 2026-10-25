import { CodexExecProcesses, type CodexExecProcessesOptions } from "./CodexExecProcesses.ts";
import { CodexExecFileSystem } from "./CodexExecFileSystem.ts";
import type { ExecSessionHandler } from "./CodexExecSessions.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { RpcError } from "./CodexExecProtocol.ts";

export type CodexExecHandlerOptions = CodexExecProcessesOptions & {
  readonly filesystem: KernelFileSystem;
};

/** Composes process and filesystem RPCs over one execution environment. */
export class CodexExecHandler implements ExecSessionHandler {
  readonly #processes: CodexExecProcesses;
  readonly #files: CodexExecFileSystem;
  #closing = false;

  constructor(options: CodexExecHandlerOptions) {
    this.#processes = new CodexExecProcesses(options);
    this.#files = new CodexExecFileSystem(options);
  }

  request(method: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.#closing) return Promise.reject(new RpcError(-32600, "Exec-server session is closed"));
    if (method.startsWith("fs/")) return this.#files.request(method, value, signal);
    return this.#processes.request(method, value, signal);
  }

  async dispose(): Promise<void> {
    this.#closing = true;
    await this.#processes.dispose();
    await this.#files.dispose();
  }
}
