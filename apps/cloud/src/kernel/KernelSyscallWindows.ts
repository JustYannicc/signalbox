import type { KernelSyscallRequest } from "./KernelSyscallPort.ts";
import type { SyscallMemory } from "./syscall/SyscallMemory.ts";

const MIN_WINDOW = 64 * 1024;
const MAX_WINDOW = 1024 * 1024;

type DescriptorKind = "file" | "stdio" | "other" | undefined;

interface SyscallWindowUse {
  readonly moved: number;
  readonly transferLimit: number;
  readonly currentWindow: number;
  readonly descriptor: DescriptorKind;
  readonly nonblocking: boolean;
}

/** Tracks read and write demand while exposing their maximum as the next shared grant. */
export function createKernelSyscallWindows() {
  let readWindow = MIN_WINDOW;
  let writeWindow = MIN_WINDOW;

  return {
    get preferredWindow() {
      return Math.max(readWindow, writeWindow);
    },

    observe(request: KernelSyscallRequest, memory: SyscallMemory, use: SyscallWindowUse) {
      const direction = transferDirection(request.name);
      if (direction === undefined) return;

      const offset = request.transferOffset ?? 0;
      const guestLength = syscallPayloadLength(request, memory, offset);
      if (
        guestLength === undefined ||
        guestLength === 0 ||
        !guestTransferComplete(request, guestLength, use)
      )
        return;

      const window = direction === "read" ? readWindow : writeWindow;
      const totalUse = offset + use.moved;
      const currentWindow = Math.min(window, use.currentWindow);
      const requestedCapacity = Math.min(guestLength - offset, use.transferLimit);
      const descriptorLimitedRead =
        direction === "read" &&
        use.moved < requestedCapacity &&
        (use.descriptor === "file" || (use.descriptor === "stdio" && use.moved > 0));
      const fullyUsed = totalUse >= currentWindow || descriptorLimitedRead;
      const nextWindow = fullyUsed
        ? Math.min(MAX_WINDOW, window * 2)
        : Math.max(MIN_WINDOW, Math.floor(window / 2));

      if (direction === "read") readWindow = nextWindow;
      else writeWindow = nextWindow;
    },
  };
}

function syscallPayloadLength(
  request: KernelSyscallRequest,
  memory: SyscallMemory,
  offset: number,
): number | undefined {
  switch (request.name) {
    case "fd_read":
    case "fd_write":
    case "fd_pread":
    case "fd_pwrite":
      try {
        const remaining = memory
          .iovecs(Number(request.args[1]), Number(request.args[2]))
          .reduce((total, vector) => total + vector.length, 0);
        return Math.min(0xffff_ffff, offset + remaining);
      } catch {
        return undefined;
      }
    case "fd_readdir":
      return Number(request.args[2]);
    case "path_readlink":
      return Number(request.args[4]);
    default:
      return undefined;
  }
}

function guestTransferComplete(
  request: KernelSyscallRequest,
  length: number,
  use: SyscallWindowUse,
) {
  const name = request.name;
  const offset = request.transferOffset ?? 0;
  if (use.moved === 0 || offset + use.moved >= length) return true;
  if (name === "fd_read" || name === "fd_pread")
    return use.descriptor !== "file" || use.moved < use.transferLimit || use.nonblocking;
  if (name === "fd_readdir" || name === "path_readlink") return use.moved < use.transferLimit;
  return use.descriptor === "stdio" && use.nonblocking;
}

function transferDirection(name: string): "read" | "write" | undefined {
  switch (name) {
    case "fd_read":
    case "fd_pread":
    case "fd_readdir":
    case "path_readlink":
      return "read";
    case "fd_write":
    case "fd_pwrite":
      return "write";
    default:
      return undefined;
  }
}
