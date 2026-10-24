import type { KernelFileSystem } from "../KernelFileSystem.ts";
import { kernelFileByteViewStorage } from "../KernelLowerFileSystemStorage.ts";
import { KernelRevisionWorkspaceError, errorCode } from "./RevisionErrors.ts";
import type { Persistence } from "./RevisionTypes.ts";

export function assertNamespacePathsOwned(
  filesystem: KernelFileSystem,
  mountPath: string,
  storage: Persistence["storage"],
  paths: readonly string[],
): void {
  for (const path of paths) {
    const segments = path.slice(1).split("/");
    for (let length = 1; length <= segments.length; length++) {
      const prefix = `/${segments.slice(0, length).join("/")}`;
      try {
        assertOwnedResolvedPath(
          filesystem.resolve(guestPath(mountPath, prefix), { followFinal: false }),
          storage,
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") continue;
        throw error;
      }
    }
  }
}

export function assertOwnedResolvedPath(
  resolved: ReturnType<KernelFileSystem["resolve"]>,
  storage: Persistence["storage"],
): void {
  if (kernelFileByteViewStorage(resolved.mount.storage, resolved.inode) !== storage)
    throw new KernelRevisionWorkspaceError(
      "EINVAL",
      "A revision path resolves outside the persistence storage",
    );
}

export function guestPath(mountPath: string, workspacePath: string): string {
  return mountPath === "/" ? workspacePath : `${mountPath}${workspacePath}`;
}
