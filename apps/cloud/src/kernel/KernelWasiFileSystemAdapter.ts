import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelLowerFileSystemPathSearch } from "./KernelLowerFileSystem.ts";
import { KernelBrokenPipeError } from "./KernelPipe.ts";
import { KernelProcessSignal, type KernelSigpipeDisposition } from "./KernelProcessSignal.ts";
import { createKernelWasiDeviceAdapter } from "./KernelWasiDevices.ts";
import { complete, type WasiCall } from "./wasi/internal_wasi_calls.ts";
import type { WasiFileSystemImportAdapter } from "./wasi/internal_wasi_lifecycle.ts";
import { nimbusWasiMetadata } from "./KernelNimbusWasiMetadata.ts";

const SIGPIPE = 13;

export interface KernelWasiSignalOptions {
  readonly sigpipe?: KernelSigpipeDisposition;
  readonly process?: Pick<KernelAsyncProgramContext, "processes" | "identity">;
}

export interface KernelWasiFileSystemOptions {
  readonly nimbusStatMetadata?: boolean;
  /** Lets callers batch a PATH candidate across live search directories before stat or open. */
  readonly preparePathSearch?: KernelLowerFileSystemPathSearch;
  readonly signal?: AbortSignal;
}

/** Signal policy belongs to the writing program; Node uses these pipes with EPIPE alone. */
export function createKernelWasiFileSystemAdapter(
  filesystem: KernelFileSystem,
  options: KernelWasiSignalOptions = {},
  fileSystemOptions: KernelWasiFileSystemOptions = {},
): WasiFileSystemImportAdapter {
  const devices = createKernelWasiDeviceAdapter(filesystem);
  const prepared: WasiFileSystemImportAdapter = (memory, imports) => {
    const base = devices(memory, imports);
    if (fileSystemOptions.preparePathSearch === undefined) return base;
    return {
      ...base,
      path_filestat_get: function* (fd, flags, path, pathLen, output): WasiCall<number> {
        yield* complete(
          fileSystemOptions.preparePathSearch!(
            memory.string(path, pathLen),
            fd,
            fileSystemOptions.signal,
          ),
        );
        return yield* base.path_filestat_get(fd, flags, path, pathLen, output);
      },
      path_open: function* (
        fd,
        dirflags,
        path,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFd,
      ): WasiCall<number> {
        yield* complete(
          fileSystemOptions.preparePathSearch!(
            memory.string(path, pathLen),
            fd,
            fileSystemOptions.signal,
          ),
        );
        return yield* base.path_open(
          fd,
          dirflags,
          path,
          pathLen,
          oflags,
          rightsBase,
          rightsInheriting,
          fdflags,
          openedFd,
        );
      },
    };
  };
  return (memory, imports) => ({
    ...(fileSystemOptions.nimbusStatMetadata
      ? nimbusWasiMetadata(memory, prepared(memory, imports))
      : prepared(memory, imports)),
    fd_write: function* (fd, iovs, iovsLen, nwritten): WasiCall<number> {
      try {
        return yield* imports.fd_write(fd, iovs, iovsLen, nwritten);
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
          if (error.bytesWritten > 0) {
            memory.u32(nwritten, error.bytesWritten);
            return 0;
          }
        }
        throw error;
      }
    },
  });
}
