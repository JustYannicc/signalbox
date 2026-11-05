import { RpcTarget } from "cloudflare:workers";
import type { ComputerProgramOwnerPort } from "../kernel/KernelComputerAdmissionPort.ts";
import type { ComputerExecutionConfiguration } from "./ComputerExecutionObject.ts";

interface Target extends ComputerProgramOwnerPort {
  configure(input: ComputerExecutionConfiguration): Promise<void>;
}

/** Facet stubs stay in their parent; sibling owners receive this transferable RPC capability. */
export class ComputerExecutionPort extends RpcTarget implements Target {
  readonly #target;
  constructor(target: Target) {
    super();
    this.#target = target;
  }
  async configure(input: ComputerExecutionConfiguration) {
    await this.#target.configure(input);
  }
  async registrations() {
    return await this.#target.registrations();
  }
  async admit(...args: Parameters<Target["admit"]>) {
    return await this.#target.admit(...args);
  }
  async cancel(...args: Parameters<Target["cancel"]>) {
    await this.#target.cancel(...args);
  }
  async close() {
    await this.#target.close();
  }
}
