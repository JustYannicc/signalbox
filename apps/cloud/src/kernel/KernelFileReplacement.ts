import type { KernelFileSystem } from "./KernelFileSystem.ts";

export function canReplaceKernelFile(
  filesystem: Pick<KernelFileSystem, "stat" | "lstat" | "access" | "posixCredentials">,
  path: string,
): boolean {
  try {
    const target = filesystem.stat(path);
    if (target.type !== "file") return false;
    // Same-owner chown does not yet clear set-ID bits in the kernel.
    if (((target.posix?.mode ?? 0) & 0o6000) !== 0) return false;
    filesystem.access(path, 4, true);
    const directory = path.slice(0, path.lastIndexOf("/")) || "/";
    // Both temp creation and final rename need directory write/search permission.
    filesystem.access(directory, 3, true);
    const parent = filesystem.stat(directory).posix;
    const uid = filesystem.posixCredentials?.euid;
    // The kernel does not yet enforce sticky-directory rename ownership.
    if (
      parent !== undefined &&
      (parent.mode & 0o1000) !== 0 &&
      uid !== 0 &&
      (uid === undefined || (uid !== parent.uid && uid !== filesystem.lstat(path).posix?.uid))
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
