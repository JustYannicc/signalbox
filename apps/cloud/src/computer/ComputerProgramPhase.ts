import type { KernelBashPhasePort } from "../kernel/KernelBashDispatchPort.ts";
import { retainRpcCapability } from "../rpc/Capability.ts";

/** A phase can outlive logical exit, but never its physical runner lifetime. */
export class ComputerProgramPhase {
  readonly #capability;
  readonly port;
  #active = true;
  #revoked: Promise<void> | undefined;
  #stopped: Promise<void> | undefined;
  #closed: Promise<void> | undefined;
  constructor(phase: KernelBashPhasePort, onAbort: (reason: unknown) => void) {
    this.#capability = retainRpcCapability(phase);
    this.port = this.#capability.value;
    void this.port.aborted().then(
      (result) => {
        if (this.#active && result.aborted) onAbort(result.reason);
      },
      (error: unknown) => {
        // Disposing a completed RPC stub rejects any still-pending aborted() call.
        if (this.#active) onAbort(error);
      },
    );
  }
  revoke() {
    return (this.#revoked ??= this.port.revoke());
  }
  stopped() {
    this.#active = false;
    return (this.#stopped ??= this.port.stopped());
  }
  after(lifetime: Promise<unknown>) {
    return lifetime.then(
      () => this.close(),
      async (error: unknown) => {
        try {
          await this.close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Bash phase and cleanup failed", {
            cause: cleanup,
          });
        }
        throw error;
      },
    );
  }
  close() {
    this.#active = false;
    return (this.#closed ??= (async () => {
      const failures: unknown[] = [];
      // No runner lifetime means preparation failed before a physical dispatch existed.
      for (const finish of [() => this.revoke(), () => this.stopped()]) {
        try {
          await finish();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        this.#capability[Symbol.dispose]();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Bash phase cleanup failed", { cause: failures[0] });
    })());
  }
}
