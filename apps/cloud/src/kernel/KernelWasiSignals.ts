import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import { createKernelWasiDeviceAdapter } from "./KernelWasiDevices.ts";
import { mapErrno, type WasiCall } from "./wasi/internal_wasi_calls.ts";
import type { WasiFileSystemImportAdapter } from "./wasi/internal_wasi_lifecycle.ts";

/** Signal policy belongs to the writing personality; Node uses the same pipes with EPIPE alone. */
export function createKernelWasiFileSystemAdapter(
  filesystem: KernelFileSystem,
): WasiFileSystemImportAdapter {
  const devices = createKernelWasiDeviceAdapter(filesystem);
  return (memory, imports) => ({
    ...devices(memory, imports),
    fd_write: function* (...args): WasiCall<number> {
      try {
        return yield* imports.fd_write(...args);
      } catch (error) {
        // Kernel WASI has no sigaction delivery API, so SIGPIPE uses its default disposition.
        if (mapErrno(error) === 64) throw new KernelProcessSignal(13);
        throw error;
      }
    },
  });
}
