import type { ChildWorkerCapacity } from "../../computer/ChildWorkerCapacity.ts";
import { CodeModeCell, type CellObservation } from "./cell.ts";
import type { CodeModeDelegates } from "./delegates.ts";
import type {
  CodeModeCellCode,
  CodeModeCellLoaderPort,
  CodeModeExecuteRequest,
  Json,
  RuntimeResponse,
  WaitOutcome,
} from "./types.ts";

interface SessionOptions {
  id: string;
  loader: CodeModeCellLoaderPort;
  code: CodeModeCellCode;
  cellCapacity: Pick<ChildWorkerCapacity, "acquire">;
  delegates: CodeModeDelegates;
  send: (message: unknown) => void;
}

export class CodeModeSession {
  readonly #values = new Map<string, Json>();
  readonly #cells = new Map<string, CodeModeCell>();
  readonly #lifetimes = new Set<Promise<void>>();
  readonly #options: SessionOptions;
  readonly #pending = new Set<AbortController>();
  #nextId = 1;
  #closing = false;

  constructor(options: SessionOptions) {
    this.#options = options;
  }

  execute(request: CodeModeExecuteRequest, signal: AbortSignal) {
    if (this.#closing) throw new Error("CodeMode session is shutting down");
    const admission = new AbortController();
    const onAbort = () => admission.abort(signal.reason);
    const detach = () => {
      signal.removeEventListener("abort", onAbort);
      this.#pending.delete(admission);
    };
    this.#pending.add(admission);
    // Detach the per-request listener after admission; AbortSignal.any would retain it for the session lifetime.
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const id = String(this.#nextId++);
    const cell = new CodeModeCell({
      id,
      sessionId: this.#options.id,
      request,
      storedValues: () => Object.fromEntries(this.#values),
      loader: this.#options.loader,
      code: this.#options.code,
      admissionController: admission,
      cellCapacity: this.#options.cellCapacity,
      admissionSettled: detach,
      delegates: this.#options.delegates,
      commit: (writes) => {
        for (const [key, value] of Object.entries(writes)) this.#values.set(key, value);
      },
    });
    this.#cells.set(id, cell);
    this.#lifetimes.add(cell.lifetime);
    void cell.lifetime.finally(() => {
      this.#lifetimes.delete(cell.lifetime);
      if (cell.admissionState === "cancelled") this.#close(cell);
    });
    return cell;
  }

  async observe(
    cell: CodeModeCell,
    yieldMs: number,
    observation: CellObservation,
  ): Promise<RuntimeResponse> {
    try {
      const response = await cell.observe(yieldMs, observation);
      if (!("Yielded" in response)) this.#close(cell);
      return response;
    } catch (error) {
      if (cell.admissionState === "cancelled") this.#close(cell);
      throw error;
    }
  }

  async wait(id: string, yieldMs: number, observation: CellObservation): Promise<WaitOutcome> {
    const cell = this.#cells.get(id);
    if (cell === undefined) return missingCell(id);
    return { LiveCell: await this.observe(cell, yieldMs, observation) };
  }

  async terminate(id: string): Promise<WaitOutcome> {
    const cell = this.#cells.get(id);
    if (cell === undefined) return missingCell(id);
    await cell.terminate();
    // A pending observer and termination both receive the terminal event.
    const response = cell.terminalResponse();
    this.#close(cell);
    return { LiveCell: response };
  }

  async shutdown() {
    this.#closing = true;
    // Closing withdraws queued acquisitions so shutdown cannot wait for capacity held elsewhere.
    for (const queued of this.#pending)
      queued.abort(new Error("CodeMode session is shutting down"));
    await Promise.all([...this.#cells.values()].map((cell) => cell.terminate()));
    await Promise.all(this.#lifetimes);
    for (const cell of this.#cells.values()) this.#close(cell);
    this.#values.clear();
  }

  #close(cell: CodeModeCell) {
    if (this.#cells.get(cell.id) !== cell) return;
    this.#cells.delete(cell.id);
    // Closing a queued cell withdraws its capacity request before the cell can outlive the session.
    cell.close();
    void cell.lifetime.then(() =>
      this.#options.send({ type: "cell/closed", sessionId: this.#options.id, cellId: cell.id }),
    );
  }
}

function missingCell(id: string): WaitOutcome {
  return {
    MissingCell: {
      Result: {
        cell_id: id,
        content_items: [],
        error_text: `exec cell ${id} not found`,
        code_mode_host_duration_ns: 0,
      },
    },
  };
}
