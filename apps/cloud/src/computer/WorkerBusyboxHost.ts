import { RpcTarget } from "cloudflare:workers";
import { resolveHiddenPreopenFd } from "../kernel/AgentOsWasi.ts";
import { createKernelBusyboxHost } from "../kernel/KernelBusyboxHost.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import { KernelOpenFlags } from "../kernel/KernelFileSystem.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type {
  KernelBusyboxCall,
  KernelBusyboxCallResult,
  KernelBusyboxPort,
} from "../kernel/KernelBusyboxPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

type CwdDirectoryMapping = {
  readonly filesystem: Pick<KernelFileSystem, "descriptors">;
  readonly preopenFd: number;
  readonly cwdFd: number;
};

const DIRECTORY_FD_ARGUMENTS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  fd_advise: [0],
  fd_allocate: [0],
  fd_close: [0],
  fd_datasync: [0],
  fd_fdstat_get: [0],
  fd_fdstat_set_flags: [0],
  fd_fdstat_set_rights: [0],
  fd_filestat_get: [0],
  fd_filestat_set_size: [0],
  fd_filestat_set_times: [0],
  fd_pread: [0],
  fd_read: [0],
  fd_readdir: [0],
  fd_seek: [0],
  fd_sync: [0],
  fd_tell: [0],
  fd_write: [0],
  path_create_directory: [0],
  path_filestat_get: [0],
  path_filestat_set_times: [0],
  path_link: [0, 4],
  path_open: [0],
  path_readlink: [0],
  path_remove_directory: [0],
  path_rename: [0, 3],
  path_symlink: [2],
  path_unlink_file: [0],
});

class WorkerBusyboxPort extends RpcTarget implements KernelBusyboxPort {
  readonly #port: ChildHostRef<KernelBusyboxPort>;
  readonly #lease: ChildHostLease;
  readonly #directoryMapping: CwdDirectoryMapping | undefined;

  constructor(
    port: ChildHostRef<KernelBusyboxPort>,
    lease: ChildHostLease,
    directoryMapping: CwdDirectoryMapping | undefined,
  ) {
    super();
    this.#port = port;
    this.#lease = lease;
    this.#directoryMapping = directoryMapping;
  }

  async call(request: KernelSyscallRequest) {
    this.#lease.observe(request.memorySize);
    return this.#port.get().call(mapRelativeDirectoryFds(request, this.#directoryMapping));
  }

  async callBusybox(request: KernelBusyboxCall): Promise<KernelBusyboxCallResult> {
    this.#lease.observe(request.memorySize);
    return this.#port.get().callBusybox(request);
  }
}

/** Passes only the admitted process's BusyBox and WASI callbacks to the child worker. */
export function createWorkerBusyboxHost(
  options: {
    readonly context: KernelAsyncProgramContext;
    readonly relativePathsFromCwd?: boolean;
  },
  lease: ChildHostLease,
) {
  const directoryMapping = options.relativePathsFromCwd
    ? createCwdDirectoryMapping(options.context)
    : undefined;
  let owner: ReturnType<typeof createKernelBusyboxHost>;
  try {
    owner = createKernelBusyboxHost({ context: options.context });
  } catch (error) {
    closeCwdDirectoryMapping(options.context, directoryMapping);
    throw error;
  }
  return {
    host: new WorkerBusyboxPort(lease.hold(owner.port), lease, directoryMapping),
    close: async () => {
      try {
        await owner.close();
      } finally {
        closeCwdDirectoryMapping(options.context, directoryMapping);
      }
    },
  };
}

function createCwdDirectoryMapping(context: KernelAsyncProgramContext): CwdDirectoryMapping {
  const { filesystem } = context;
  const rootPreopen = [...filesystem.descriptors.entries()].find(
    ([, descriptor]) =>
      descriptor.kind === "directory" &&
      descriptor.preopen === true &&
      descriptor.mount?.path === "/",
  );
  if (rootPreopen === undefined) throw new Error("The child filesystem root preopen is missing");
  return {
    filesystem,
    preopenFd: rootPreopen[0],
    cwdFd: filesystem.open(filesystem.cwd, KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY),
  };
}

function closeCwdDirectoryMapping(
  context: KernelAsyncProgramContext,
  mapping: CwdDirectoryMapping | undefined,
) {
  if (mapping !== undefined && context.filesystem.descriptors.has(mapping.cwdFd)) {
    context.filesystem.close(mapping.cwdFd);
  }
}

function mapRelativeDirectoryFds(
  request: KernelSyscallRequest,
  mapping: CwdDirectoryMapping | undefined,
): KernelSyscallRequest {
  if (mapping === undefined) return request;
  const indexes = DIRECTORY_FD_ARGUMENTS[request.name];
  if (indexes === undefined) return request;

  let args: Array<number | bigint> | undefined;
  for (const index of indexes) {
    const fd = request.args[index];
    if (
      typeof fd !== "number" ||
      resolveHiddenPreopenFd(fd, mapping.filesystem) !== mapping.preopenFd
    ) {
      continue;
    }
    args ??= [...request.args];
    args[index] = mapping.cwdFd;
  }
  return args === undefined ? request : { ...request, args };
}
