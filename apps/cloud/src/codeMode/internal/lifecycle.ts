import type { CodeModeLifecycleEvent, CodeModeLifecycleObserver } from "../Lifecycle.ts";
import { messageError } from "../Types.ts";

export class CodeModeCellLifecycle {
  readonly #identity;
  readonly #observer;
  readonly #failures: unknown[] = [];
  #started = false;

  constructor(options: {
    sessionId: string;
    cellId: string;
    tool_call_id: string;
    observer?: CodeModeLifecycleObserver | undefined;
  }) {
    this.#identity = {
      sessionId: options.sessionId,
      cellId: options.cellId,
      tool_call_id: options.tool_call_id,
    };
    this.#observer = options.observer;
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    this.#send({ ...this.#identity, type: "started" });
  }

  close(aborted: boolean, error: string | null) {
    const failure = error ?? (this.#failures.length ? messageError(this.#failures[0]) : null);
    this.#send(
      !this.#started && aborted && failure === null
        ? { ...this.#identity, type: "queued-cancel" }
        : {
            ...this.#identity,
            type: "closed",
            started: this.#started,
            outcome: failure !== null ? "error" : aborted ? "aborted" : "completed",
            error: failure,
          },
    );
    if (this.#failures.length)
      throw new AggregateError(this.#failures, "CodeMode lifecycle observer failed");
  }

  #send(event: CodeModeLifecycleEvent) {
    try {
      this.#observer?.(Object.freeze(event));
    } catch (error) {
      // Observation must not strand an admitted worker or skip its cleanup.
      this.#failures.push(error);
    }
  }
}
