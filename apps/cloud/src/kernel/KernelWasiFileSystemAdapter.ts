import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelBrokenPipeError } from "./KernelPipe.ts";
import { KernelProcessSignal, type KernelSigpipeDisposition } from "./KernelProcessSignal.ts";
import { createKernelWasiDeviceAdapter } from "./KernelWasiDevices.ts";
import type { WasiCall } from "./wasi/internal_wasi_calls.ts";
import type { WasiFileSystemImportAdapter } from "./wasi/internal_wasi_lifecycle.ts";

const SIGPIPE = 13;

export interface KernelWasiSignalOptions {
  readonly sigpipe?: KernelSigpipeDisposition;
  readonly process?: Pick<KernelAsyncProgramContext, "processes" | "identity">;
}

/** Signal policy belongs to the writing program; Node uses these pipes with EPIPE alone. */
export function createKernelWasiFileSystemAdapter(
  filesystem: KernelFileSystem,
  options: KernelWasiSignalOptions = {},
): WasiFileSystemImportAdapter {
  const devices = createKernelWasiDeviceAdapter(filesystem);
  return (memory, imports) => ({
    ...devices(memory, imports),
    fd_write: function* (...args): WasiCall<number> {
      try {
        return yield* imports.fd_write(...args);
      } catch (error) {
        if (error instanceof KernelBrokenPipeError) {
          // The guest ABI has no sigaction delivery; masked default actions remain pending.
          if (options.process === undefined) {
            if (options.sigpipe !== "epipe") throw new KernelProcessSignal(SIGPIPE);
          } else {
            const result = options.process.processes.generateSignal(
              options.process.identity.handle,
              SIGPIPE,
            );
            if (result.status !== "ok")
              throw new Error("Writing process signal state is unavailable", { cause: error });
          }
        }
        throw error;
      }
    },
  });
}
