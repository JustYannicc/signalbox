import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelLowerFileSystemPathSearch } from "./KernelLowerFileSystem.ts";

/** Prefetch never selects an executable; the guest still walks its current PATH and checks access. */
export function createKernelFileSystemPathSearch(
  filesystem: KernelFileSystem,
  searchPath: string | undefined,
): KernelLowerFileSystemPathSearch {
  return async (path, directoryFd, signal) => {
    if (path.includes("\0") || path === "") return;
    let base: string;
    try {
      const descriptor = filesystem.descriptors.get(directoryFd);
      if (
        descriptor.kind !== "directory" ||
        descriptor.mount === undefined ||
        descriptor.pathComponents === undefined
      )
        return;
      base = `${descriptor.mount.path.replace(/\/$/, "")}/${descriptor.pathComponents.join("/")}`;
    } catch {
      // The actual syscall reports invalid descriptors without performing prefetch I/O.
      return;
    }
    const candidate = absolute(path, base);
    const slash = candidate.lastIndexOf("/");
    const name = candidate.slice(slash + 1);
    const directory = candidate.slice(0, slash) || "/";
    const directories = (searchPath ?? "").split(":").map((entry) => {
      const directory = entry.startsWith("/") ? entry : absolute(entry || ".", filesystem.cwd);
      return directory.replace(/\/$/, "") || "/";
    });
    const paths = directories.includes(directory)
      ? directories.map((entry) => `${entry === "/" ? "" : entry}/${name}`)
      : [candidate];
    try {
      await filesystem.prepareLowerPaths([...new Set([candidate, ...paths])], signal);
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["EACCES", "ENOENT", "ENOTDIR"].includes(String(error.code))
        )
      )
        throw error;
    }
  };
}

function absolute(path: string, base: string): string {
  return path.startsWith("/") ? path : `${base.replace(/\/$/, "")}/${path}`;
}
