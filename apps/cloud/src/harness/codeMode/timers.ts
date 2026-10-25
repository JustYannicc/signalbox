import type { CodeModeQueue } from "./queue.ts";

/** Logical timers can be cleared or revoked before a request ever arms a native timer. */
export class CodeModeTimers {
  readonly #queue: CodeModeQueue;
  readonly #timers = new Map<number, { callback: () => void; remaining: number }>();
  #next = 1;
  #active = true;

  constructor(queue: CodeModeQueue) {
    this.#queue = queue;
  }

  set(callback: unknown, delay?: unknown) {
    if (typeof callback !== "function") throw "setTimeout expects a function callback";
    const id = this.#next++;
    const numeric = Number(delay);
    const remaining = Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
    this.#timers.set(id, { callback: () => callback(), remaining });
    this.#queue.push({ kind: "timer-arm", id });
    return id;
  }

  clear(value: unknown) {
    if (value == null) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const id = Math.trunc(numeric);
    if (this.#timers.delete(id)) this.#queue.push({ kind: "timer-clear", id });
  }

  chunk(id: number) {
    const timer = this.#timers.get(id);
    if (!this.#active || timer === undefined) return undefined;
    const chunk = Math.min(timer.remaining, 2_147_483_647);
    timer.remaining -= chunk;
    return chunk;
  }

  fire(id: number) {
    const timer = this.#timers.get(id);
    if (!this.#active || timer === undefined) return;
    if (timer.remaining > 0) {
      this.#queue.push({ kind: "timer-arm", id });
      return;
    }
    this.#timers.delete(id);
    timer.callback();
  }

  revoke() {
    this.#active = false;
    this.#timers.clear();
  }
}
