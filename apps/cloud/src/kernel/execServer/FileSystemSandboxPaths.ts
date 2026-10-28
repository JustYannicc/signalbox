import { KernelOpenFlags, type KernelFileSystem } from "../KernelFileSystem.ts";

export const withinSandboxPath = (root: string, path: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);

export function sandboxParent(path: string) {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "/" : path.slice(0, end);
}

export function sandboxJoin(root: string, suffix: string) {
  const parts: string[] = [];
  for (const part of (suffix.startsWith("/") ? suffix : `${root}/${suffix}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function sandboxStat(files: KernelFileSystem, path: string) {
  try {
    return files.stat(path);
  } catch (error) {
    if (sandboxErrorCode(error) !== "ENOENT") throw error;
    return undefined;
  }
}

// New leaves inherit their nearest existing parent's canonical location. Resolving
// a dangling link first prevents a writable alias from granting its outside target.
export function resolveSandboxPath(files: KernelFileSystem, path: string, links = 0): string {
  try {
    return files.realpath(path);
  } catch (error) {
    if (sandboxErrorCode(error) !== "ENOENT") throw error;
  }
  try {
    if (files.lstat(path).type === "symlink") {
      if (links >= 40) throw Object.assign(new Error("Too many symbolic links"), { code: "ELOOP" });
      const target = files.readlink(path);
      return resolveSandboxPath(
        files,
        target.startsWith("/") ? target : `${sandboxParent(path)}/${target}`,
        links + 1,
      );
    }
  } catch (error) {
    if (sandboxErrorCode(error) !== "ENOENT") throw error;
  }
  const parent = sandboxParent(path);
  if (parent === path) return path;
  return sandboxJoin(
    resolveSandboxPath(files, parent, links),
    path.slice(path.lastIndexOf("/") + 1),
  );
}

export function firstMissingSandboxPath(files: KernelFileSystem, path: string) {
  let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    current = sandboxJoin(current, part);
    if (sandboxStat(files, current) === undefined) return current;
  }
  return undefined;
}

export function sandboxGitdir(files: KernelFileSystem, path: string) {
  const fd = files.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const size = Number(files.fstat(fd).size);
    if (!Number.isSafeInteger(size)) return undefined;
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const count = files.read(fd, bytes.subarray(offset), null);
      if (count === 0) break;
      offset += count;
    }
    const contents = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, offset))
      .trim();
    const colon = contents.indexOf(":");
    if (colon < 0 || contents.slice(0, colon).trim() !== "gitdir") return undefined;
    const target = contents.slice(colon + 1).trim();
    if (target === "") return undefined;
    const resolved = sandboxJoin(sandboxParent(path), target);
    return sandboxStat(files, resolved) ? resolveSandboxPath(files, resolved) : undefined;
  } catch {
    return undefined;
  } finally {
    files.close(fd);
  }
}

export function writableSandboxSymlink(
  files: KernelFileSystem,
  path: string,
  roots: readonly string[],
) {
  let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    current = sandboxJoin(current, part);
    try {
      if (
        files.lstat(current).type === "symlink" &&
        roots.some((root) => withinSandboxPath(root, current))
      )
        return current;
    } catch (error) {
      if (sandboxErrorCode(error) === "ENOENT") break;
      throw error;
    }
  }
  return undefined;
}

export function sandboxErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
