import type { KernelHandle } from "../KernelAbi.ts";
import type { KernelFileByteSelection } from "../KernelFileBytes.ts";
import { KernelFileSystem } from "../KernelFileSystem.ts";
import { withKernelErrors } from "../filesystem/KernelFileSystemErrors.ts";
import type { AgentOsSpawnFileAction } from "../process/AgentOsProcessActions.ts";
import { runSync } from "../wasi/internal_wasi_calls.ts";
import { assertKernelFileByteSelectionCompatible } from "./KernelProgramFileBytes.ts";
import {
  RIGHTS,
  type WasiDescriptorSpec,
  type WasiStdio,
} from "../wasi/internal_wasi_descriptors.ts";
import {
  closeAllDescriptors,
  applyFileActions,
  installDescriptor,
} from "./KernelProgramFileActions.ts";

export interface KernelProgramPrepareInput {
  readonly filesystem: KernelFileSystem;
  readonly parent?: KernelHandle<"process">;
  readonly signal?: AbortSignal;
  /** Canonical guest home path supplied by the owner; never derived from a host path. */
  readonly home?: string;
}

export interface KernelProgramPrepareOptions {
  /** Optional target lets the host select the process view before file actions. */
  readonly executable?: string;
  readonly cwd?: string;
  readonly actions?: readonly AgentOsSpawnFileAction[];
  /** Process-local default used by ordinary opens before its ordered file actions run. */
  readonly fileBytes?: KernelFileByteSelection;
  /** Borrowed streams replace the child's standard descriptors and remain caller-owned. */
  readonly stdio?: readonly [WasiStdio | undefined, WasiStdio | undefined, WasiStdio | undefined];
}

export type { KernelProgramFileByteSelector } from "./KernelProgramFileBytes.ts";

export interface KernelOwnedStdio {
  readonly descriptors: readonly [
    WasiDescriptorSpec | undefined,
    WasiDescriptorSpec | undefined,
    WasiDescriptorSpec | undefined,
  ];
  /** Runs after the child descriptor fork and before standard descriptors are replaced. */
  readonly prepareActions?: (filesystem: KernelFileSystem) => readonly AgentOsSpawnFileAction[];
  /** Called only when a prepared child is released before ownership transfers. */
  readonly releaseBeforeTransfer?: () => void;
}

export class KernelPreparedProgram {
  readonly filesystem: KernelFileSystem;
  readonly parent: KernelHandle<"process"> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly home: string | undefined;
  #state: "owned" | "transferred" | "released" = "owned";
  #releasePromise: Promise<void> | undefined;
  readonly #releaseBeforeTransfer: (() => void) | undefined;

  constructor(
    filesystem: KernelFileSystem,
    parent: KernelHandle<"process"> | undefined,
    signal: AbortSignal | undefined,
    home: string | undefined,
    releaseBeforeTransfer?: () => void,
  ) {
    this.filesystem = filesystem;
    this.parent = parent;
    this.signal = signal;
    this.home = home;
    this.#releaseBeforeTransfer = releaseBeforeTransfer;
  }

  /** Call from every owner; a transferred child is cleaned by its process record. */
  release(): Promise<void> {
    if (this.#state !== "owned") return this.#releasePromise ?? Promise.resolve();
    this.#state = "released";
    this.#releasePromise = Promise.resolve().then(() => {
      const errors: unknown[] = [];
      try {
        closeAllDescriptors(this.filesystem.descriptors);
      } catch (error) {
        errors.push(error);
      }
      try {
        this.#releaseBeforeTransfer?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.filesystem.dispose();
      } catch (error) {
        errors.push(error);
      }
      throwCleanupErrors(errors, "Prepared program cleanup failed");
    });
    return this.#releasePromise;
  }

  /** Synchronous cleanup for a synchronous inline tool. */
  releaseSync(): void {
    if (this.#state === "released") return;
    if (this.#state === "transferred") throw new Error("Prepared program is owned by a process");
    this.#state = "released";
    const errors: unknown[] = [];
    try {
      closeAllDescriptors(this.filesystem.descriptors);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#releaseBeforeTransfer?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.filesystem.dispose();
    } catch (error) {
      errors.push(error);
    }
    throwCleanupErrors(errors, "Prepared program cleanup failed");
  }

  /** @internal */
  transfer(): void {
    if (this.#state !== "owned")
      throw new Error("Prepared program is no longer owned by its caller");
    this.#state = "transferred";
  }

  /** @internal */
  get canTransfer(): boolean {
    return this.#state === "owned";
  }

  /** @internal */
  releaseTransferred(): Promise<void> {
    if (this.#state === "released") return this.#releasePromise ?? Promise.resolve();
    this.#state = "released";
    this.#releasePromise = Promise.resolve().then(() => {
      const errors: unknown[] = [];
      try {
        closeAllDescriptors(this.filesystem.descriptors);
      } catch (error) {
        errors.push(error);
      }
      try {
        this.filesystem.dispose();
      } catch (error) {
        errors.push(error);
      }
      throwCleanupErrors(errors, "Prepared program cleanup failed");
    });
    return this.#releasePromise;
  }

  /** @internal */
  markLifecycleReleased(): void {
    if (this.#state === "released") return;
    this.#state = "released";
    this.#releasePromise ??= Promise.resolve();
    this.filesystem.dispose();
  }
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

export function prepareKernelProgram(
  input: KernelProgramPrepareInput,
  options: KernelProgramPrepareOptions = {},
  ownedStdio?: KernelOwnedStdio,
): KernelPreparedProgram {
  if (input.signal?.aborted)
    throw Object.assign(new Error("Program preparation cancelled"), { code: "ECANCELED" });
  const parentTable = input.filesystem.descriptors;
  const mappings = [...parentTable.entries()].map(([parentFd]) => ({
    parentFd,
    childFd: parentFd,
  }));
  const childTable = parentTable.fork(mappings, { exec: false });
  let childFilesystem: KernelFileSystem | undefined;
  try {
    return withKernelErrors(() => {
      childFilesystem = input.filesystem.fork(
        childTable,
        options.fileBytes === undefined ? {} : { fileBytes: options.fileBytes },
      );
      const preparedActions = ownedStdio?.prepareActions?.(childFilesystem) ?? [];
      const untransferredCleanup = ownedStdio?.releaseBeforeTransfer;
      if (ownedStdio !== undefined) {
        for (const [fd, descriptor] of ownedStdio.descriptors.entries()) {
          if (descriptor !== undefined) installDescriptor(childFilesystem, fd, descriptor);
        }
      }
      if (options.stdio !== undefined) {
        for (const [fd, stdio] of options.stdio.entries()) {
          if (stdio !== undefined && ownedStdio?.descriptors[fd] === undefined) {
            installDescriptor(childFilesystem, fd, borrowedStdioDescriptor(fd, stdio));
          }
        }
      }
      if (options.cwd !== undefined) childFilesystem.chdir(options.cwd);
      applyFileActions(childFilesystem, [...preparedActions, ...(options.actions ?? [])]);
      assertKernelFileByteSelectionCompatible(childTable.entries(), childFilesystem.fileBytes, {
        survivingOnly: true,
      });
      // Spawn mappings include close-on-exec descriptors so file actions can use them.
      // The sweep happens once, after every ordered action has completed.
      runSync(childTable.closeOnExecSweep());
      return new KernelPreparedProgram(
        childFilesystem,
        input.parent,
        input.signal,
        input.home,
        untransferredCleanup,
      );
    });
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      closeAllDescriptors(childTable);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      ownedStdio?.releaseBeforeTransfer?.();
    } catch (releaseError) {
      errors.push(releaseError);
    }
    try {
      childFilesystem?.dispose();
    } catch (disposeError) {
      errors.push(disposeError);
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Program preparation and cleanup failed", { cause: error });
    }
    throw error;
  }
}

function borrowedStdioDescriptor(fd: number, stdio: WasiStdio): WasiDescriptorSpec {
  const ioRight = fd === 0 ? RIGHTS.FD_READ : RIGHTS.FD_WRITE;
  return {
    kind: "stdio",
    stdio,
    offset: 0n,
    rightsBase:
      ioRight |
      RIGHTS.POLL_FD_READWRITE |
      RIGHTS.FD_FDSTAT_SET_FLAGS |
      RIGHTS.FD_SYNC |
      RIGHTS.FD_DATASYNC |
      RIGHTS.FD_FILESTAT_GET,
    rightsInheriting: 0n,
    flags: 0,
  };
}
