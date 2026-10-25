import type { MachineFileStat } from "@signalbox/runner-protocol/MachineFilesProtocol";
import { KernelFileSystemUnavailable } from "../../kernel/KernelLowerFileSystem.ts";

interface LiveParentOperations {
  readonly lstat: (path: string) => Promise<MachineFileStat>;
  readonly readlink: (path: string) => Promise<string>;
}

/** A request owns these caches so directory provenance never survives its machine generation. */
export function liveSymlinkParents(operations: LiveParentOperations) {
  const parents = new Map<string, Promise<string>>();
  const stats = new Map<string, Promise<MachineFileStat>>();
  const links = new Map<string, Promise<string>>();
  const lstat = (path: string) => {
    let result = stats.get(path);
    if (result === undefined) {
      result = operations.lstat(path);
      stats.set(path, result);
    }
    return result;
  };
  const readlink = (path: string) => {
    let result = links.get(path);
    if (result === undefined) {
      result = operations.readlink(path);
      links.set(path, result);
    }
    return result;
  };
  const resolve = async (path: string) => {
    const pending = path.split("/").filter(Boolean);
    const components: string[] = [];
    let depth = 0;
    while (pending.length > 0) {
      const part = pending.shift()!;
      if (part === ".") continue;
      if (part === "..") {
        components.pop();
        continue;
      }
      const candidate = `/${[...components, part].join("/")}`;
      const stat = await lstat(candidate);
      if (stat.type === "symlink") {
        if (++depth > 40)
          throw Object.assign(new Error("Too many live machine symlinks"), { code: "ELOOP" });
        const target = await readlink(candidate);
        if (target.length === 0 || target.includes("\0"))
          throw new KernelFileSystemUnavailable("Machine returned an invalid ancestor symlink");
        if (target.startsWith("/")) components.length = 0;
        pending.unshift(...target.split("/").filter(Boolean));
      } else {
        if (stat.type !== "directory")
          throw new KernelFileSystemUnavailable("Machine symlink parent is no longer a directory");
        components.push(part);
      }
    }
    return `/${components.join("/")}`;
  };
  return async (path: string) => {
    const slash = path.lastIndexOf("/");
    const parent = slash === 0 ? "/" : path.slice(0, slash);
    let physical = parents.get(parent);
    if (physical === undefined) {
      physical = resolve(parent);
      parents.set(parent, physical);
    }
    const resolved = await physical;
    return resolved === parent ? undefined : resolved;
  };
}
