// @effect-diagnostics nodeBuiltinImport:off - Guest path semantics use the same POSIX builtin as Node.
import * as NodePath from "node:path";
import { kernelError } from "../../kernel/KernelErrno.ts";
import type { KernelPosixOptions, KernelStat } from "../../kernel/KernelFileSystem.ts";
import type { createNodeFsSyscallClient } from "../../isolate/NodeFsSyscallClient.ts";
import type { CliFileWorkingSet } from "./WorkingSet.ts";
import type { CliFilePaths } from "./Paths.ts";

/** Updates the read projection while queued mutations retain their remote error barrier. */
export function createCliMetadataMutations(options: {
  readonly files: CliFileWorkingSet;
  readonly paths: CliFilePaths;
  readonly remote: ReturnType<typeof createNodeFsSyscallClient>;
  readonly policy: () => KernelPosixOptions | undefined;
}) {
  const { files, paths, remote } = options;
  const entry = (path: string, follow = true) => files.metadata(paths.resolve(path, follow));
  const parent = (path: string) => entry(NodePath.posix.dirname(paths.destination(path)));
  const absent = (path: string) => {
    try {
      files.metadata(path);
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
        return;
      throw cause;
    }
    throw kernelError("EEXIST");
  };
  const access = (path: string, mode = 0, effective = false) => {
    const metadata = entry(path).stat;
    const policy = options.policy();
    if (mode === 0) return;
    if (policy === undefined || metadata.posix === undefined) throw kernelError("ENOTSUP");
    paths.assertAccess(metadata, mode, effective);
  };
  const createMetadata = (
    path: string,
    type: "file" | "directory" | "symlink",
    mode: number,
    target?: string,
  ) => {
    const ancestor = parent(path);
    const policy = options.policy();
    const stat: KernelStat = {
      ...ancestor.stat,
      type,
      ino: 0n,
      nlink: 1n,
      size: BigInt(target?.length ?? 0),
      ...(policy === undefined
        ? {}
        : {
            posix: {
              uid: policy.credentials.euid,
              gid: policy.credentials.egid,
              mode: type === "symlink" ? 0o777 : mode & ~policy.umask,
            },
          }),
    };
    return {
      path: paths.destination(path),
      stat,
      pending: true as const,
      ...(target === undefined ? {} : { target }),
    };
  };
  return {
    access,
    chmod(path: string, mode: number, follow = true) {
      const current = entry(path, follow);
      if (current.stat.posix === undefined) throw kernelError("ENOTSUP");
      files.writes.enqueue(0, async () => {
        await remote.chmod(current.path, mode, follow);
      });
      files.updateMetadata({
        ...current,
        stat: { ...current.stat, posix: { ...current.stat.posix, mode } },
      });
    },
    chown(path: string, uid: number, gid: number, follow = true) {
      const current = entry(path, follow);
      if (current.stat.posix === undefined) throw kernelError("ENOTSUP");
      files.writes.enqueue(0, async () => {
        await remote.chown(current.path, uid, gid, follow);
      });
      files.updateMetadata({
        ...current,
        stat: { ...current.stat, posix: { mode: current.stat.posix.mode & ~0o6000, uid, gid } },
      });
    },
    setTimes(path: string, times: Parameters<NodeFsBackendTimes>[1], follow = true) {
      const current = entry(path, follow);
      files.writes.enqueue(0, async () => {
        await remote.setTimes(current.path, times, follow);
      });
      files.updateMetadata({
        ...current,
        stat: {
          ...current.stat,
          ...(times.atimeNs === undefined ? {} : { atimeNs: times.atimeNs }),
          ...(times.mtimeNs === undefined ? {} : { mtimeNs: times.mtimeNs }),
        },
      });
    },
    mkdir(path: string, mode = 0o777) {
      const created = createMetadata(path, "directory", mode);
      absent(created.path);
      files.writes.enqueue(0, async () => {
        await remote.mkdir(created.path, mode);
      });
      files.updateMetadata(created);
    },
    rmdir(path: string) {
      const current = entry(path, false);
      if (current.stat.type !== "directory") throw kernelError("ENOTDIR");
      if (files.children(current.path).length > 0) throw kernelError("ENOTEMPTY");
      files.writes.enqueue(0, async () => {
        await remote.rmdir(current.path);
      });
      files.updateMetadata({ path: current.path, removed: true });
    },
    unlink(path: string) {
      const current = entry(path, false);
      if (current.stat.type === "directory") throw kernelError("EISDIR");
      files.writes.enqueue(0, async () => {
        await remote.unlink(current.path);
      });
      files.updateMetadata({ path: current.path, removed: true });
    },
    symlink(target: string, path: string) {
      const created = createMetadata(path, "symlink", 0o777, target);
      absent(created.path);
      files.writes.enqueue(0, async () => {
        await remote.symlink(target, created.path);
      });
      files.updateMetadata(created);
    },
    link(source: string, destination: string) {
      const current = entry(source);
      const target = paths.destination(destination);
      absent(target);
      files.writes.enqueue(0, async () => {
        await remote.link(current.path, target);
      });
      for (const item of files.entries)
        if (item.stat.ino === current.stat.ino && item.stat.dev === current.stat.dev)
          files.updateMetadata({ ...item, stat: { ...item.stat, nlink: item.stat.nlink + 1n } });
      files.updateMetadata({
        ...current,
        path: target,
        stat: { ...current.stat, nlink: current.stat.nlink + 1n },
      });
    },
    rename(source: string, destination: string) {
      const current = entry(source, false);
      const target = paths.destination(destination);
      if (current.path === target) return;
      files.writes.enqueue(0, async () => {
        await remote.rename(current.path, target);
      });
      // All descendants are metadata only; the owner performs the actual atomic rename.
      const changed = files.entries.filter(
        (item) => item.path === current.path || item.path.startsWith(`${current.path}/`),
      );
      for (const item of changed) {
        files.updateMetadata({ ...item, path: target + item.path.slice(current.path.length) });
        files.updateMetadata({ path: item.path, removed: true });
      }
    },
    createMetadata,
  };
}

type NodeFsBackendTimes = import("../../isolate/NodeFsBackend.ts").NodeFsBackend["setTimes"];
