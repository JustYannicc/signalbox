import { kernelError, kernelOk, type KernelResult } from "../KernelAbi.ts";

export interface KernelSignalMask {
  readonly low: number;
  readonly high: number;
}

const UNBLOCKABLE = (1n << 8n) | (1n << 18n);

export function validSignalMask(mask: KernelSignalMask): boolean {
  return [mask.low, mask.high].every(
    (word) => Number.isSafeInteger(word) && word >= 0 && word <= 0xffff_ffff,
  );
}

/** Logical-process state shared by every adapter for the same process handle. */
export class KernelProcessSignals {
  #blocked: bigint;
  readonly #pending = new Set<number>();

  constructor(mask: KernelSignalMask = { low: 0, high: 0 }) {
    this.#blocked = this.#bits(mask) & ~UNBLOCKABLE;
  }

  get mask(): KernelSignalMask {
    return { low: Number(this.#blocked & 0xffff_ffffn), high: Number(this.#blocked >> 32n) };
  }

  change(how: number, mask: KernelSignalMask): KernelSignalMask {
    const previous = this.mask;
    const requested = this.#bits(mask) & ~UNBLOCKABLE;
    if (how === 0) this.#blocked |= requested;
    else if (how === 1) this.#blocked &= ~requested;
    else if (how === 2) this.#blocked = requested;
    return previous;
  }

  send(signal: number, deliver: (signal: number) => KernelResult<void>): KernelResult<void> {
    if (this.#isBlocked(signal)) {
      // The pinned AgentOS ABI coalesces each of its 64 signal numbers.
      this.#pending.add(signal);
      return kernelOk(undefined);
    }
    const wasPending = this.#pending.delete(signal);
    const result = this.#deliver(signal, deliver);
    if (wasPending && result.status !== "ok") this.#pending.add(signal);
    return result;
  }

  flush(deliver: (signal: number) => KernelResult<void>): KernelResult<void> {
    for (const signal of Array.from(this.#pending)) {
      // Delivery may reenter this state and drain or block another pending signal.
      if (!this.#pending.has(signal) || this.#isBlocked(signal)) continue;
      this.#pending.delete(signal);
      const result = this.#deliver(signal, deliver);
      if (result.status !== "ok") {
        this.#pending.add(signal);
        return result;
      }
    }
    return kernelOk(undefined);
  }

  #deliver(signal: number, deliver: (signal: number) => KernelResult<void>): KernelResult<void> {
    try {
      return deliver(signal);
    } catch {
      return kernelError("IO_ERROR", "Process signal failed");
    }
  }

  #isBlocked(signal: number) {
    return (this.#blocked & (1n << BigInt(signal - 1))) !== 0n;
  }

  #bits(mask: KernelSignalMask) {
    return BigInt(mask.low) | (BigInt(mask.high) << 32n);
  }
}
