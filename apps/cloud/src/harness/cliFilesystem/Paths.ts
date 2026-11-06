// @effect-diagnostics nodeBuiltinImport:off - Guest path semantics use the same POSIX builtin as Node.
import * as NodePath from "node:path";
import type { CliFileWorkingSet } from "./WorkingSet.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import type { KernelPosixOptions, KernelStat } from "../../kernel/KernelFileSystem.ts";

/** Resolves the owner's metadata index only. No storage or descriptor lookup happens here. */
export class CliFilePaths {
  readonly #files;
  readonly #policy;
  #cwd;
  constructor(files: CliFileWorkingSet, cwd: string, policy: () => KernelPosixOptions | undefined) {
    this.#files = files;
    this.#policy = policy;
    this.#cwd = cwd;
  }
  get cwd() {
    return this.#cwd;
  }
  absolute(path: string) {
    return NodePath.posix.resolve(this.#cwd, path);
  }
  get policy() {
    return this.#policy();
  }
  assertAccess(stat: KernelStat, mode: number, effective = true) {
    const policy = this.#policy();
    if (mode === 0 || policy === undefined) return;
    if (stat.posix === undefined) throw kernelError("ENOTSUP");
    const { credentials } = policy;
    const uid = effective ? credentials.euid : credentials.uid;
    const gid = effective ? credentials.egid : credentials.gid;
    const owner = stat.posix;
    if (uid === 0) {
      if (stat.type !== "directory" && (mode & 1) !== 0 && (owner.mode & 0o111) === 0)
        throw kernelError("EACCES");
      return;
    }
    const shift =
      uid === owner.uid ? 6 : gid === owner.gid || credentials.groups?.includes(owner.gid) ? 3 : 0;
    if (((owner.mode >>> shift) & mode) !== mode) throw kernelError("EACCES");
  }
  resolve(path: string, follow = true) {
    const absolute = this.absolute(path);
    const resolve = (name: string, depth: number): string => {
      if (depth > 40) throw kernelError("ELOOP");
      const components = name.split("/").filter(Boolean);
      let current = "/";
      for (let index = 0; index < components.length; index++) {
        const entry = this.#files.metadata(current);
        if (entry.stat.type !== "directory") throw kernelError("ENOTDIR");
        this.assertAccess(entry.stat, 1);
        current = NodePath.posix.join(current, components[index]!);
        const child = this.#files.metadata(current);
        if (child.stat.type === "symlink" && (follow || index !== components.length - 1)) {
          if (child.target === undefined) throw kernelError("EIO");
          return resolve(
            NodePath.posix.resolve(
              NodePath.posix.dirname(current),
              child.target,
              ...components.slice(index + 1),
            ),
            depth + 1,
          );
        }
      }
      this.#files.metadata(current);
      return current;
    };
    return resolve(absolute, 0);
  }
  destination(path: string) {
    const absolute = this.absolute(path);
    const parent = this.resolve(NodePath.posix.dirname(absolute));
    if (this.#files.metadata(parent).stat.type !== "directory") throw kernelError("ENOTDIR");
    return NodePath.posix.join(parent, NodePath.posix.basename(absolute));
  }
  chdir(path: string) {
    const directory = this.resolve(path);
    if (this.#files.metadata(directory).stat.type !== "directory") throw kernelError("ENOTDIR");
    this.assertAccess(this.#files.metadata(directory).stat, 1);
    this.#cwd = directory;
  }
}
