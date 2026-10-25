// @effect-diagnostics globalConsole:off - preserve nonfatal notification delivery warnings.
import type { CodeModeGlobals } from "./globals.ts";
import type { CodeModeJob } from "./queue.ts";
import { messageError, type CodeModeCellEvents } from "./types.ts";

export function captureCodeModeEffects() {
  const nativeSet = globalThis.setTimeout.bind(globalThis);
  return {
    setTimeout: (callback: () => void, delay: number) => nativeSet(callback, delay),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    warn: globalThis.console?.warn.bind(globalThis.console),
  };
}

/** All I/O starts in this handler-owned loop, never inside guest module evaluation. */
export class CodeModePump {
  readonly #runtime: CodeModeGlobals;
  readonly #events: CodeModeCellEvents;
  readonly #effects: ReturnType<typeof captureCodeModeEffects>;
  readonly #handles = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #notifications = new Set<Promise<void>>();
  readonly #failed = Promise.withResolvers<never>();
  #output = Promise.resolve();
  #task: Promise<void> | undefined;
  #cancelled = false;
  #closed = false;

  constructor(
    runtime: CodeModeGlobals,
    events: CodeModeCellEvents,
    effects: ReturnType<typeof captureCodeModeEffects>,
  ) {
    this.#runtime = runtime;
    this.#events = events;
    this.#effects = effects;
    void this.#failed.promise.catch(() => undefined);
  }

  get failure() {
    return this.#failed.promise;
  }

  fail(error: unknown) {
    this.#failed.reject(error);
  }

  start() {
    this.#task = this.#run();
    void this.#task.catch((error: unknown) => this.fail(error));
  }

  async flush() {
    if (this.#task === undefined) throw new Error("CodeMode pump has not started");
    await Promise.race([this.#runtime.queue.flush(), this.#task]);
  }

  async drainNotifications() {
    await Promise.all(this.#notifications);
  }

  async drainOutput() {
    await this.#output;
  }

  clearTimers() {
    for (const handle of this.#handles.values()) this.#effects.clearTimeout(handle);
    this.#handles.clear();
  }

  cancel() {
    this.#cancelled = true;
    this.clearTimers();
  }

  async close() {
    this.#closed = true;
    this.clearTimers();
    this.#runtime.queue.push({ kind: "stop" });
    // The handler already observes loop errors through failure and still owns final teardown.
    await this.#task?.catch(() => undefined);
  }

  async #run() {
    for (;;) {
      const batch = await this.#runtime.queue.take();
      for (const job of batch) {
        if (job.kind === "stop") return;
        if (job.kind === "barrier") job.resolve();
        else {
          try {
            this.#dispatch(job);
          } catch (error) {
            // A throwing timer callback may already have queued output which still needs delivery.
            this.fail(error);
          }
        }
      }
    }
  }

  #dispatch(job: Exclude<CodeModeJob, { kind: "stop" | "barrier" }>) {
    switch (job.kind) {
      case "output":
        if (this.#cancelled) return;
        // Only output shares this lane. A slow delegate cannot block another tool or a timer.
        this.#output = this.#output.then(() => {
          if (!this.#cancelled) return this.#events.emit(job.event);
        });
        void this.#output.catch((error: unknown) => this.fail(error));
        return;
      case "tool":
        if (this.#cancelled) return;
        void this.#invoke(job).catch((error: unknown) => this.fail(error));
        return;
      case "notify": {
        if (this.#cancelled) return;
        const notification = this.#notify(job.text).finally(() =>
          this.#notifications.delete(notification),
        );
        this.#notifications.add(notification);
        void notification.catch((error: unknown) => this.fail(error));
        return;
      }
      case "timer-arm": {
        const chunk = this.#runtime.timers.chunk(job.id);
        if (chunk === undefined) return;
        const handle = this.#effects.setTimeout(() => {
          this.#handles.delete(job.id);
          this.#runtime.queue.push({ kind: "timer-fired", id: job.id });
        }, chunk);
        this.#handles.set(job.id, handle);
        return;
      }
      case "timer-clear": {
        const handle = this.#handles.get(job.id);
        if (handle !== undefined) this.#effects.clearTimeout(handle);
        this.#handles.delete(job.id);
        return;
      }
      case "timer-fired":
        this.#runtime.timers.fire(job.id);
    }
  }

  async #invoke(job: Extract<CodeModeJob, { kind: "tool" }>) {
    try {
      const value = await this.#events.invoke(job.index, job.argument, job.id);
      this.#runtime.settleTool(job.id, { value });
    } catch (error) {
      this.#runtime.settleTool(job.id, { error: messageError(error) });
    }
  }

  async #notify(text: string) {
    try {
      await this.#events.notify(text);
    } catch (error) {
      if (!this.#closed) this.#effects.warn?.("failed to deliver code mode notification:", error);
    }
  }
}
