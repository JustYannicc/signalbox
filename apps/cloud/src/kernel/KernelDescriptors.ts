import { KernelWakeRegistry, type WakeToken } from "./KernelWakeRegistry.ts";
import {
  FDFLAGS,
  RIGHTS,
  WasiDescriptorTable,
  type WasiPollResult,
  type WasiStdio,
} from "./wasi/internal_wasi_descriptors.ts";
import { runSync } from "./wasi/internal_wasi_calls.ts";
import { WasiError } from "./wasi/internal_wasi_memory.ts";

export type { WasiPollResult } from "./wasi/internal_wasi_descriptors.ts";

const MAX_ALLOCATED_FD = 0x7fff_ffff;

export interface KernelDescriptorResource {
  ready(direction: "read" | "write"): WasiPollResult | undefined;
  subscribe(direction: "read" | "write", notify: () => void): () => void;
  close(): void;
}

/** A socket-like resource attached to the kernel's shared WASI fd namespace. */
export class KernelDescriptors {
  readonly table: WasiDescriptorTable;
  readonly wakes: KernelWakeRegistry;

  constructor(table: WasiDescriptorTable, wakes: KernelWakeRegistry) {
    this.table = table;
    this.wakes = wakes;
  }

  /** The caller transfers ownership only when this returns an fd. */
  register(resource: KernelDescriptorResource): number {
    if (!isKernelDescriptorResource(resource)) {
      throw descriptorError("EINVAL", "Invalid descriptor resource");
    }

    const stdio = new KernelResourceStdio(resource, this.wakes);
    try {
      return this.table.allocate({
        kind: "stdio",
        stdio,
        offset: 0n,
        rightsBase:
          RIGHTS.FD_READ | RIGHTS.FD_WRITE | RIGHTS.FD_FDSTAT_SET_FLAGS | RIGHTS.POLL_FD_READWRITE,
        rightsInheriting: 0n,
        flags: FDFLAGS.NONBLOCK,
        // Runtime sockets belong to their owner; explicit dup still clears CLOEXEC.
        closeOnExec: true,
        onLastClose: () => resource.close(),
      });
    } catch (error) {
      throw publicDescriptorError(error);
    }
  }

  /** Resolves a resource through its descriptor attachment, including table aliases. */
  resource(fd: number): KernelDescriptorResource {
    try {
      const descriptor = this.table.get(fd);
      const stdio = descriptor.kind === "stdio" ? descriptor.stdio : undefined;
      if (!(stdio instanceof KernelResourceStdio)) {
        throw descriptorError("EBADF", "Descriptor does not refer to a kernel resource");
      }
      return stdio.resource;
    } catch (error) {
      throw publicDescriptorError(error);
    }
  }

  /** Creates the lowest free alias at or above minFd in the shared fd namespace. */
  duplicate(fd: number, minFd = 0): number {
    this.resource(fd);
    if (!Number.isSafeInteger(minFd) || minFd < 0 || minFd > MAX_ALLOCATED_FD) {
      throw descriptorError("EINVAL", "Minimum descriptor is out of range");
    }

    const limit = Math.min(MAX_ALLOCATED_FD, minFd + Array.from(this.table.entries()).length);
    for (let targetFd = minFd; targetFd <= limit; targetFd++) {
      if (this.table.has(targetFd)) continue;
      try {
        return runSync(
          this.table.duplicateTo(fd, targetFd, {
            closeOnExec: false,
          }),
        );
      } catch (error) {
        const mapped = publicDescriptorError(error);
        if (mapped.code === "EBUSY") continue;
        throw mapped;
      }
    }
    throw descriptorError("EMFILE", "No descriptor is available at or above minFd");
  }

  close(fd: number): void {
    this.resource(fd);
    try {
      runSync(this.table.close(fd));
    } catch (error) {
      throw publicDescriptorError(error);
    }
  }
}

class KernelResourceStdio implements WasiStdio {
  readonly resource: KernelDescriptorResource;
  readonly #wakes: KernelWakeRegistry;

  constructor(resource: KernelDescriptorResource, wakes: KernelWakeRegistry) {
    this.resource = resource;
    this.#wakes = wakes;
  }

  poll(direction: "read" | "write", signal: AbortSignal): WasiPollResult | Promise<WasiPollResult> {
    if (signal.aborted) throw descriptorError("ECANCELED", "Readiness wait cancelled");
    const result = this.resource.ready(direction);
    return result !== undefined ? result : this.#waitUntilReady(direction, signal);
  }

  async #waitUntilReady(direction: "read" | "write", signal: AbortSignal): Promise<WasiPollResult> {
    for (;;) {
      if (signal.aborted) throw descriptorError("ECANCELED", "Readiness wait cancelled");
      const ready = this.resource.ready(direction);
      if (ready !== undefined) return ready;

      const registration = this.#wakes.register((notify) =>
        this.resource.subscribe(direction, notify),
      );
      if (registration.status !== "ok") {
        throw wakeError(registration.error.code, registration.error.message);
      }

      const token: WakeToken = registration.value;
      try {
        // Close the gap between the first readiness check and subscription.
        const afterSubscribe = this.resource.ready(direction);
        if (afterSubscribe !== undefined) return afterSubscribe;

        const result = await this.#wakes.wait(token, signal);
        if (result.status !== "ok") {
          throw wakeError(result.error.code, result.error.message);
        }
      } finally {
        this.#wakes.release(token);
      }
    }
  }
}

function isKernelDescriptorResource(value: KernelDescriptorResource): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.ready === "function" &&
    typeof value.subscribe === "function" &&
    typeof value.close === "function"
  );
}

function wakeError(code: string, message: string): Error {
  switch (code) {
    case "RESOURCE_LIMIT":
      return descriptorError("ENOMEM", message);
    case "EXPIRED":
      return descriptorError("ETIMEDOUT", message);
    case "CANCELLED":
      return descriptorError("ECANCELED", message);
    default:
      return descriptorError("EIO", message);
  }
}

function publicDescriptorError(error: unknown): Error & { readonly code: string } {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error as Error & { readonly code: string };
  }
  if (error instanceof WasiError) {
    switch (error.errno) {
      case 8:
        return descriptorError("EBADF", "Invalid descriptor");
      case 10:
        return descriptorError("EBUSY", "Descriptor is busy");
      case 20:
        return descriptorError("EEXIST", "Descriptor already exists");
      case 28:
        return descriptorError("EINVAL", "Invalid descriptor argument");
      case 33:
        return descriptorError("EMFILE", "Descriptor table is full");
      case 76:
        return descriptorError("ENOTCAPABLE", "Descriptor rights cannot be increased");
      default:
        break;
    }
  }
  return descriptorError("EIO", "Descriptor operation failed");
}

function descriptorError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
