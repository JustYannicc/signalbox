import type { ProcessSlotLease, ProcessSlotPermit, ProcessSlots } from "../ProcessSlots.ts";
import type { ChildWorkerExecution, ChildWorkerPermit, ChildWorkerRequester } from "./types.ts";

export interface ChildWorkerPermitHooks {
  readonly bind: (requester: ChildWorkerRequester) => void;
  readonly ending: () => void;
  readonly ended: () => void;
  readonly failed: () => void;
}

export class ProcessSlotChildWorkerPermit implements ChildWorkerPermit {
  readonly execution: ChildWorkerExecution;
  readonly #bind: ChildWorkerPermitHooks["bind"];

  constructor(
    slots: ProcessSlots,
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    hooks: ChildWorkerPermitHooks,
    residentByteLimit: number,
  ) {
    this.#bind = hooks.bind;
    this.execution = new ProcessSlotChildWorkerExecution(
      slots,
      lease,
      permit,
      hooks,
      residentByteLimit,
    );
  }

  bind(requester: ChildWorkerRequester): void {
    this.#bind(requester);
  }

  release(): Promise<void> {
    return (this.execution as ProcessSlotChildWorkerExecution).release();
  }
}

class ProcessSlotChildWorkerExecution implements ChildWorkerExecution {
  readonly lease: ProcessSlotLease;
  readonly permit: ProcessSlotPermit;
  readonly loaderId: string;
  readonly residentByteLimit: number;
  readonly #slots: ProcessSlots;
  readonly #hooks: ChildWorkerPermitHooks;
  #settled = false;
  #ending: Promise<void> | undefined;

  constructor(
    slots: ProcessSlots,
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    hooks: ChildWorkerPermitHooks,
    residentByteLimit: number,
  ) {
    this.#slots = slots;
    this.lease = lease;
    this.permit = permit;
    this.loaderId = lease.loaderId;
    this.residentByteLimit = residentByteLimit;
    this.#hooks = hooks;
    Object.freeze(this);
  }

  observe(residentBytes: number): void {
    this.#slots.observe(this.lease, residentBytes);
  }

  lose(reason: "memory" | "isolate"): Promise<void> {
    return this.#terminal(() => this.#slots.lose(this.lease, reason));
  }

  handoff(): Promise<void> {
    return this.#terminal(() => this.#slots.handoff(this.lease, { acknowledged: true }));
  }

  release(): Promise<void> {
    return this.#terminal(() => this.#slots.release(this.lease, { acknowledged: true }));
  }

  #terminal(action: () => Promise<void>): Promise<void> {
    if (this.#settled) return Promise.resolve();
    if (this.#ending !== undefined) return this.#ending;
    this.#hooks.ending();
    const ending = action().then(
      () => {
        this.#settled = true;
        this.#hooks.ended();
      },
      (error: unknown) => {
        this.#hooks.failed();
        this.#ending = undefined;
        throw error;
      },
    );
    this.#ending = ending;
    return ending;
  }
}
