import type { Computer, ComputerExecPort, ComputerOpenPort } from "./Computer.ts";

export interface ComputerBindings extends ComputerExecPort {
  readonly files: Computer["files"];
  readonly port: Computer["port"];
  readonly save: Computer["save"];
}

/** One factory belongs to the owning thread object; repeated opens share the same Computer. */
export function createComputerFactory(
  bind: (threadId: string, signal: AbortSignal) => Promise<ComputerBindings>,
): ComputerOpenPort {
  let opening: { readonly threadId: string; readonly computer: Promise<Computer> } | undefined;
  return Object.freeze({
    async open(threadId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!threadId) throw new TypeError("Computer requires a thread identity");
      if (opening) {
        if (opening.threadId !== threadId) throw new Error("Computer belongs to another thread");
        return opening.computer;
      }
      const computer = Promise.resolve()
        .then(async () => {
          const ports = await bind(threadId, signal);
          signal.throwIfAborted();
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
      return computer;
    },
  });
}
