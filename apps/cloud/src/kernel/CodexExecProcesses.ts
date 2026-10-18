import type { ExecSessionHandler } from "./CodexExecSessions.ts";
import {
  invalidRequest,
  processIdParams,
  readParams,
  RpcError,
  signalParams,
  writeParams,
} from "./CodexExecProtocol.ts";
import {
  ProcessesRegistry,
  isStarting,
  type ProcessesRegistryOptions,
} from "./execServer/ProcessesRegistry.ts";

export type CodexExecProcessesOptions = ProcessesRegistryOptions;

/** Exec-server process RPCs scoped to one resumable protocol session. */
export class CodexExecProcesses implements ExecSessionHandler {
  readonly #registry: ProcessesRegistry;
  #closing = false;

  constructor(options: CodexExecProcessesOptions) {
    this.#registry = new ProcessesRegistry(options);
  }

  async request(method: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.#closing) return invalidRequest("Exec-server session is closed");
    switch (method) {
      case "process/start":
        return this.#registry.start(value, signal);
      case "process/read": {
        const params = readParams(value);
        const process = this.#registry.get(params.processId);
        if (!process) return invalidRequest(`unknown process id ${params.processId}`);
        if (isStarting(process))
          return invalidRequest(`process id ${params.processId} is starting`);
        return process.read(params, signal);
      }
      case "process/write": {
        const params = writeParams(value);
        const process = this.#registry.get(params.processId);
        if (!process) return { status: "unknownProcess" };
        if (isStarting(process)) return { status: "starting" };
        return process.write(params.writeId, params.chunk, signal);
      }
      case "process/signal": {
        const { processId } = signalParams(value);
        const process = this.#registry.get(processId);
        if (process && !isStarting(process)) await process.signal(2);
        return {};
      }
      case "process/terminate": {
        const { processId } = processIdParams(value);
        const process = this.#registry.get(processId);
        if (!process) return { running: false };
        if (isStarting(process)) {
          this.#registry.cancelStarting(process);
          return { running: true };
        }
        return { running: await process.terminate() };
      }
      default:
        throw new RpcError(-32601, "Method not found");
    }
  }

  async dispose(): Promise<void> {
    this.#closing = true;
    await this.#registry.dispose();
  }
}
