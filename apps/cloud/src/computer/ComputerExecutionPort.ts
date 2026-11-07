import { RpcTarget } from "cloudflare:workers";
import type { ComputerProgramOwnerPort } from "../kernel/KernelComputerAdmissionPort.ts";
import type { ComputerExecutionConfiguration } from "./ComputerExecutionObject.ts";
import { isComputerOwnerUnavailable } from "./ComputerOwnerAvailability.ts";

interface Target extends ComputerProgramOwnerPort {
  configure(input: ComputerExecutionConfiguration): Promise<void>;
  configured(): Promise<boolean>;
}

/**
 * Facet stubs stay in their parent; sibling owners receive this transferable RPC capability.
 * An idle Computer facet can be evicted and lose the owner it keeps only in memory. The parent
 * holds the configuration it applied and is alive whenever a sibling calls through this port, so
 * a call that fails on an unconfigured Computer re-applies it once and retries.
 */
export class ComputerExecutionPort extends RpcTarget implements Omit<Target, "configured"> {
  readonly #target;
  #configuration: ComputerExecutionConfiguration | undefined;
  #restoring: Promise<boolean> | undefined;
  #closed = false;
  constructor(target: Target) {
    super();
    this.#target = target;
  }
  async configure(input: ComputerExecutionConfiguration) {
    await this.#target.configure(input);
    this.#configuration = input;
  }
  async registrations() {
    return await this.#restored(() => this.#target.registrations());
  }
  async admit(...args: Parameters<Target["admit"]>) {
    return await this.#restored(() => this.#target.admit(...args));
  }
  async cancel(...args: Parameters<Target["cancel"]>) {
    await this.#restored(() => this.#target.cancel(...args));
  }
  async close() {
    this.#closed = true;
    await this.#target.close();
  }
  async #restored<A>(run: () => Promise<A>): Promise<A> {
    try {
      return await run();
    } catch (error) {
      // Only the eviction's own failure is retried: any other failure, even one that lands just
      // after another caller restored the Computer, is this call's result and may have applied.
      if (!isComputerOwnerUnavailable(error) || !(await this.#restore())) throw error;
      return await run();
    }
  }
  /** Re-applies the configuration if the Computer lost it; concurrent callers share one restore. */
  async #restore() {
    const configuration = this.#configuration;
    if (configuration === undefined || this.#closed) return false;
    this.#restoring ??= (async () => {
      // Another caller may already have restored it; then the retry simply runs.
      if (!(await this.#target.configured())) await this.#target.configure(configuration);
      return true;
    })()
      // A failed restore leaves the call's own error as its result.
      .catch(() => false)
      .finally(() => {
        this.#restoring = undefined;
      });
    return await this.#restoring;
  }
}
