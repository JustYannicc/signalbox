// @effect-diagnostics globalTimers:off - V1 observations use request-owned host timers outside Effect.
import type { ChildWorkerCapacity, ChildWorkerPermit } from "../../computer/ChildWorkerCapacity.ts";
import type { CodeModeDelegates } from "./delegates.ts";
import {
  messageError,
  type CodeModeCellCode,
  type CodeModeCellEvents,
  type CodeModeCellLoaderPort,
  type CodeModeContent,
  type CodeModeExecuteRequest,
  type Json,
  type RuntimeResponse,
} from "./types.ts";

export interface CellObservation {
  readonly cancel: AbortSignal;
  readonly yield: AbortSignal;
}

export class CodeModeCell {
  #output: CodeModeContent[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #controller = new AbortController();
  readonly #delegates: CodeModeDelegates;
  readonly #sessionId: string;
  readonly #stopped = Promise.withResolvers<void>();
  readonly #cancelled = Promise.withResolvers<void>();
  readonly #lifetime: Promise<void>;
  readonly #admissionController: AbortController;
  #closed = false;
  #final: "Result" | "Terminated" | undefined;
  #error: string | null = null;
  #yielded: CodeModeContent[] | undefined;
  #acceptYield = false;
  #observerCancellation: AbortSignal | undefined;
  #terminalContent: CodeModeContent[] | undefined;
  #observing = false;
  #admission: "queued" | "cancelled" | undefined = "queued";
  readonly id: string;

  constructor(options: {
    id: string;
    sessionId: string;
    request: CodeModeExecuteRequest;
    loader: CodeModeCellLoaderPort;
    code: CodeModeCellCode;
    admissionController: AbortController;
    cellCapacity: Pick<ChildWorkerCapacity, "acquire">;
    storedValues: () => Readonly<Record<string, Json>>;
    admissionSettled: () => void;
    delegates: CodeModeDelegates;
    commit: (writes: Readonly<Record<string, Json>>) => void;
  }) {
    this.id = options.id;
    this.#sessionId = options.sessionId;
    this.#delegates = options.delegates;
    this.#admissionController = options.admissionController;
    this.#controller.signal.addEventListener("abort", () => this.#cancelled.resolve(), {
      once: true,
    });
    const events: CodeModeCellEvents = {
      emit: async (event) => {
        if (this.#closed || this.#controller.signal.aborted) return;
        if (event.type === "content") this.#output.push(event.item);
        else if (this.#acceptYield && !this.#observerCancellation?.aborted) {
          this.#yielded = this.#output.splice(0);
          this.#acceptYield = false;
        }
        this.#wake();
      },
      invoke: async (index, input, id) => {
        if (this.#closed || this.#controller.signal.aborted)
          throw new Error("CodeMode cell closed");
        const tool = options.request.enabled_tools[index];
        if (tool === undefined) throw new Error("Invalid CodeMode tool index");
        return this.#delegates.request(
          this,
          this.#sessionId,
          {
            type: "tool/invoke",
            invocation: {
              cell_id: this.id,
              runtime_tool_call_id: id,
              tool_name: tool.tool_name,
              tool_kind: tool.kind,
              input: input ?? null,
            },
          },
          "tool/result",
        );
      },
      notify: async (text) => {
        if (this.#closed || this.#controller.signal.aborted)
          throw new Error("CodeMode cell closed");
        await this.#delegates.request(
          this,
          this.#sessionId,
          {
            type: "notification/send",
            callId: options.request.tool_call_id,
            cellId: this.id,
            text,
          },
          "notification/delivered",
        );
      },
      cancelled: () => this.#cancelled.promise,
      closeCallbacks: async () => this.#closeCallbacks(),
      stopped: async () => this.#stopped.resolve(),
    };
    this.#lifetime = (async () => {
      let permit: ChildWorkerPermit | undefined;
      let started = false;
      try {
        permit = await options.cellCapacity.acquire(options.admissionController.signal, undefined);
        options.admissionController.signal.throwIfAborted();
        this.#admission = undefined;
        options.admissionSettled();
        started = true;
        const completion = await options.loader.run(
          { code: options.code, request: options.request, storedValues: options.storedValues() },
          events,
        );
        // A successful RPC return alone does not attest to guest or callback teardown.
        await this.#stopped.promise;
        if (this.#controller.signal.aborted || completion.terminated) this.#final = "Terminated";
        else {
          options.commit(completion.writes);
          this.#final = "Result";
          this.#error = completion.error;
        }
      } catch (error) {
        options.admissionSettled();
        this.#closeCallbacks();
        if (options.admissionController.signal.aborted) {
          this.#admission = "cancelled";
          this.#final = "Terminated";
        } else if (this.#controller.signal.aborted) {
          this.#final = "Terminated";
        } else {
          this.#error = messageError(error);
          this.#final = "Result";
        }
        this.#wake();
        if (started) await this.#stopped.promise;
      } finally {
        this.#closeCallbacks();
        permit?.release();
        this.#wake();
      }
    })()
      .catch((error: unknown) => {
        this.#error = messageError(error);
        this.#final = "Result";
      })
      .finally(() => {
        this.#wake();
      });
  }

  get admissionState() {
    return this.#admission;
  }

  async observe(yieldMs: number, observation: CellObservation): Promise<RuntimeResponse> {
    if (this.#observing) throw new Error(`exec cell ${this.id} already has an observation`);
    this.#observing = true;
    this.#acceptYield = true;
    this.#observerCancellation = observation.cancel;
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(yieldMs, 2_147_483_647));
    const signal = AbortSignal.any([deadline.signal, observation.yield, observation.cancel]);
    try {
      for (;;) {
        observation.cancel.throwIfAborted();
        const body = {
          cell_id: this.id,
          content_items: [] as CodeModeContent[],
          code_mode_host_duration_ns: Math.max(
            0,
            Math.trunc((performance.now() - started) * 1_000_000),
          ),
        };
        const yielded = this.#yielded;
        this.#yielded = undefined;
        if (yielded !== undefined) return { Yielded: { ...body, content_items: yielded } };
        if (this.#final !== undefined) {
          return this.terminalResponse();
        }
        if (signal.aborted) return { Yielded: { ...body, content_items: this.#output.splice(0) } };
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", wake);
            this.#waiters.delete(wake);
            resolve();
          };
          this.#waiters.add(wake);
          signal.addEventListener("abort", wake, { once: true });
          if (signal.aborted) wake();
        });
      }
    } finally {
      clearTimeout(timer);
      if (observation.cancel.aborted && this.#yielded !== undefined) {
        this.#output = [...this.#yielded, ...this.#output];
        this.#yielded = undefined;
      }
      this.#observing = false;
      this.#acceptYield = false;
      this.#observerCancellation = undefined;
    }
  }

  async terminate() {
    if (this.#final === undefined) {
      this.#controller.abort(new Error("CodeMode cell terminated"));
      if (this.#admission === "queued") {
        this.#admission = "cancelled";
        this.#admissionController.abort(new Error("CodeMode cell terminated"));
      }
      if (this.#yielded !== undefined) this.#output = [...this.#yielded, ...this.#output];
      this.#yielded = undefined;
      this.#acceptYield = false;
      this.#closeCallbacks();
    }
    await this.#lifetime;
  }

  close() {
    if (this.#admission === "queued")
      this.#admissionController.abort(new Error("CodeMode cell closed"));
    this.#closeCallbacks();
  }

  terminalResponse(): RuntimeResponse {
    this.#terminalContent ??= this.#output.splice(0);
    const body = {
      cell_id: this.id,
      content_items: this.#terminalContent.map((item) => ({ ...item })),
      code_mode_host_duration_ns: 0,
    };
    return this.#final === "Terminated"
      ? { Terminated: body }
      : { Result: { ...body, error_text: this.#error } };
  }

  get lifetime() {
    return this.#lifetime;
  }

  #closeCallbacks() {
    this.#closed = true;
    this.#cancelled.resolve();
    this.#delegates.cancel(this);
  }
  #wake() {
    // Listeners remove themselves and may install their next subscription.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const wake of [...this.#waiters]) wake();
  }
}
