import type { Computer, ComputerExecPort, ComputerOpenPort } from "./Computer.ts";

export interface ComputerBindings extends ComputerExecPort {
  readonly files: Computer["files"];
  readonly port: Computer["port"];
  readonly save: Computer["save"];
}

/** One factory belongs to the owning thread object; repeated opens share the same Computer. */
export function createComputerFactory(
  bind: (threadId: string, signal: AbortSignal) => Promise<ComputerBindings>,
  ownerSignal: AbortSignal = new AbortController().signal,
): ComputerOpenPort {
  let opening: { readonly threadId: string; readonly computer: Promise<Computer> } | undefined;
  return Object.freeze({
    async open(threadId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      ownerSignal.throwIfAborted();
      if (!threadId) throw new TypeError("Computer requires a thread identity");
      if (opening) {
        if (opening.threadId !== threadId) throw new Error("Computer belongs to another thread");
        return waitForComputer(opening.computer, AbortSignal.any([signal, ownerSignal]));
      }
      const computer = Promise.resolve()
        .then(async () => {
          const ports = await bind(threadId, ownerSignal);
          ownerSignal.throwIfAborted();
          return Object.freeze({
            threadId,
            files: ports.files,
            exec: ports.exec,
            port: ports.port,
            save: ports.save,
          });
        })
        .catch((error: unknown) => {
          opening = undefined;
          throw error;
        });
      opening = { threadId, computer };
      return waitForComputer(computer, AbortSignal.any([signal, ownerSignal]));
    },
  });
}

function waitForComputer(computer: Promise<Computer>, signal: AbortSignal): Promise<Computer> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const clear = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void computer.then(
      (value) => {
        clear();
        resolve(value);
      },
      (error: unknown) => {
        clear();
        reject(error);
      },
    );
  });
}
