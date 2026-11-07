import { DurableObject } from "cloudflare:workers";
import { ChildWorkerCapacity } from "./ChildWorkerCapacity.ts";
import { ComputerProgramOwner } from "./ComputerProgramOwner.ts";
import { COMPUTER_OWNER_UNAVAILABLE } from "./ComputerOwnerAvailability.ts";
import type { ComputerProgramOwnerOptions } from "./ComputerProgramOwner.ts";
import type { ChildWorkerLoaderPort } from "./WorkerLoaderDispatch.ts";
import type {
  KernelComputerAdmissionInput,
  KernelComputerAdmissionCapture,
} from "../kernel/KernelComputerAdmissionPort.ts";

export interface ComputerExecutionEnvironment {
  readonly CHILD_WORKERS: ChildWorkerLoaderPort;
  readonly RESIDENT_BYTE_LIMIT: string;
}

export type ComputerExecutionConfiguration = Pick<
  ComputerProgramOwnerOptions,
  "programs" | "path" | "rules"
> & { readonly limit: number };

/** A separate Worker module owns Computer policy, catalog, permits and child-loader lifetimes. */
export class ComputerExecutionObject extends DurableObject<ComputerExecutionEnvironment> {
  #owner: ComputerProgramOwner | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  async configure(config: ComputerExecutionConfiguration) {
    if (this.#closed || this.#owner !== undefined)
      throw new Error("Computer execution owner is already configured or closed");
    if (!Number.isSafeInteger(config.limit) || config.limit < 1 || config.limit > 10)
      throw new RangeError("Computer execution limit must fit its Durable Object quota");
    const capacity = new ChildWorkerCapacity(config.limit, {
      owner: `computer/${this.ctx.id}`,
      storage: this.ctx.storage,
      RESIDENT_BYTE_LIMIT: this.env.RESIDENT_BYTE_LIMIT,
    });
    this.#owner = new ComputerProgramOwner({ ...config, capacity, loader: this.env.CHILD_WORKERS });
  }
  /** The owner lives only in memory; an evicted facet answers false until it is configured again. */
  async configured() {
    return !this.#closed && this.#owner !== undefined;
  }
  #current() {
    if (this.#closed || this.#owner === undefined) throw new Error(COMPUTER_OWNER_UNAVAILABLE);
    return this.#owner;
  }
  async registrations() {
    return await this.#current().registrations();
  }
  async admit(
    id: string,
    input: KernelComputerAdmissionInput,
    kernel: KernelComputerAdmissionCapture,
  ) {
    return await this.#current().admit(id, input, kernel);
  }
  async cancel(id: string, reason?: unknown) {
    await this.#current().cancel(id, reason);
  }
  close() {
    this.#closed = true;
    return (this.#closing ??= (async () => {
      try {
        await this.#owner?.close();
      } finally {
        this.#owner = undefined;
      }
    })());
  }
}
