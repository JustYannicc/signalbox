import type { InheritedFd } from "@signalbox/runner-protocol/ExecProtocol";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import { RIGHTS } from "./wasi/internal_wasi_descriptors.ts";
import { applyFileActions } from "./program/KernelProgramFileActions.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

/** Reopening is the same contract for local children and native Runner children. */
export function describeInheritedFd(
  filesystem: KernelFileSystem,
  parentFd: number,
  childFd: number,
): InheritedFd {
  const descriptor = filesystem.descriptors.get(parentFd);
  if (
    descriptor.kind !== "file" ||
    (descriptor.rightsBase & RIGHTS.FD_READ) === 0n ||
    (descriptor.rightsBase & RIGHTS.FD_WRITE) !== 0n ||
    filesystem.fstat(parentFd).type !== "file"
  ) {
    throw kernelError("ENOTSUP", "Only linked, read-only regular files can be inherited");
  }
  let path: string;
  try {
    path = filesystem.readlink(`/proc/self/fd/${parentFd}`);
  } catch {
    throw kernelError("ENOTSUP", "An inherited file must still have a linked path");
  }
  const offset = Number(descriptor.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw kernelError("ENOTSUP", "Inherited file offset is outside the supported range");
  }
  return { childFd, path, flags: KernelOpenFlags.O_RDONLY, offset };
}

export function reopenInheritedFds(
  filesystem: KernelFileSystem,
  inheritedFds: readonly InheritedFd[],
): void {
  for (const inherited of inheritedFds) {
    const table = filesystem.descriptors;
    if (table.has(inherited.childFd) && table.get(inherited.childFd).preopen) {
      let target = 3;
      while (table.has(target) || inheritedFds.some((mapping) => mapping.childFd === target))
        target++;
      table.put(target, table.take(inherited.childFd));
    }
    applyFileActions(filesystem, [
      {
        kind: "open",
        fd: inherited.childFd,
        sourceFd: 0,
        path: inherited.path,
        flags: inherited.flags,
        mode: 0,
      },
    ]);
    describeInheritedFd(filesystem, inherited.childFd, inherited.childFd);
    const descriptor = table.get(inherited.childFd);
    descriptor.posixFd = inherited.childFd;
    descriptor.offset = BigInt(inherited.offset);
  }
}
