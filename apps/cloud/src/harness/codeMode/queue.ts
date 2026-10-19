import type { CodeModeCellEvents, Json } from "./types.ts";

export type CodeModeJob =
  | { readonly kind: "output"; readonly event: Parameters<CodeModeCellEvents["emit"]>[0] }
  | {
      readonly kind: "tool";
      readonly index: number;
      readonly argument: Json | undefined;
      readonly id: string;
    }
  | { readonly kind: "notify"; readonly text: string }
  | { readonly kind: "timer-arm" | "timer-clear" | "timer-fired"; readonly id: number }
  | { readonly kind: "barrier"; readonly resolve: () => void }
  | { readonly kind: "stop" };

/** Guest enqueue is heap-only. Only the handler creates and awaits the pump's wake promise. */
export class CodeModeQueue {
  #jobs: CodeModeJob[] = [];
  #wake: (() => void) | undefined;

  push(job: CodeModeJob) {
    this.#jobs.push(job);
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async take() {
    if (this.#jobs.length === 0)
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    return this.#jobs.splice(0);
  }

  flush() {
    return new Promise<void>((resolve) => this.push({ kind: "barrier", resolve }));
  }
}
