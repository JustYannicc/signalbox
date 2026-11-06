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
  readonly unlinkViews: (path: string) => void;
  readonly renameViews: (from: string, to: string) => void;
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
      const project = files.project([created]);
      files.writes.enqueue(0, () => remote.mkdir(created.path, mode), false, project);
    },
    rmdir(path: string) {
      const current = entry(path, false);
      if (current.stat.type !== "directory") throw kernelError("ENOTDIR");
      if (files.children(current.path).length > 0) throw kernelError("ENOTEMPTY");
      const project = files.project([{ path: current.path, removed: true }]);
      files.writes.enqueue(0, () => remote.rmdir(current.path), false, project);
    },
    unlink(path: string) {
      const current = entry(path, false);
      if (current.stat.type === "directory") throw kernelError("EISDIR");
      const aliases = files.entries.filter(
        (item) =>
          !item.pending &&
          !current.pending &&
          item.path !== current.path &&
          item.stat.ino === current.stat.ino &&
          item.stat.dev === current.stat.dev,
      );
      const project = files.project([
        { path: current.path, removed: true },
        ...aliases.map((item) => ({
          ...item,
          stat: { ...item.stat, nlink: item.stat.nlink - 1n },
        })),
      ]);
      files.writes.enqueue(
        0,
        () => remote.unlink(current.path),
        false,
        () => {
          options.unlinkViews(current.path);
          project();
        },
      );
    },
    symlink(target: string, path: string) {
      const created = createMetadata(path, "symlink", 0o777, target);
      absent(created.path);
      const project = files.project([created]);
      files.writes.enqueue(0, () => remote.symlink(target, created.path), false, project);
    },
    link(source: string, destination: string) {
      const current = entry(source, false);
      const target = paths.destination(destination);
      absent(target);
      const changed = files.entries.filter(
        (item) =>
          item.path === current.path ||
          (!item.pending &&
            !current.pending &&
            item.stat.ino === current.stat.ino &&
            item.stat.dev === current.stat.dev),
      );
      const project = files.project(
        [
          ...changed.map((item) => ({
            ...item,
            stat: { ...item.stat, nlink: item.stat.nlink + 1n },
          })),
          { ...current, path: target, stat: { ...current.stat, nlink: current.stat.nlink + 1n } },
        ],
        [{ from: current.path, to: target, copy: true }],
      );
      files.writes.enqueue(0, () => remote.link(current.path, target), false, project);
    },
    rename(source: string, destination: string) {
      const current = entry(source, false);
      const target = paths.destination(destination);
      if (current.path === target) return;
      const replaced = (() => {
        try {
          return files.metadata(target);
        } catch (cause) {
          if (
            !(
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
            )
          )
            throw cause;
          return undefined;
        }
      })();
      if (
        replaced !== undefined &&
        !current.pending &&
        !replaced.pending &&
        current.stat.ino !== 0n &&
        current.stat.ino === replaced.stat.ino &&
        current.stat.dev === replaced.stat.dev
      )
        return;
      const aliases =
        replaced === undefined || replaced.pending || replaced.stat.ino === 0n
          ? []
          : files.entries.filter(
              (item) =>
                !item.pending &&
                item.path !== target &&
                item.stat.ino === replaced.stat.ino &&
                item.stat.dev === replaced.stat.dev,
            );
      if (target.startsWith(`${current.path}/`)) throw kernelError("EINVAL");
      const changed = files.entries.filter(
        (item) => item.path === current.path || item.path.startsWith(`${current.path}/`),
      );
      const moves = changed.map((item) => ({
        from: item.path,
        to: target + item.path.slice(current.path.length),
      }));
      const project = files.project(
        [
          ...aliases.map((item) => ({
            ...item,
            stat: { ...item.stat, nlink: item.stat.nlink - 1n },
          })),
          ...changed.map((item) => ({ path: item.path, removed: true as const })),
          ...changed.map((item) => ({
            ...item,
            path: target + item.path.slice(current.path.length),
          })),
        ],
        moves,
      );
      files.writes.enqueue(
        0,
        () => remote.rename(current.path, target),
        false,
        () => {
          if (replaced !== undefined) options.unlinkViews(target);
          options.renameViews(current.path, target);
          project();
        },
      );
    },
    createMetadata,
  };
}

type NodeFsBackendTimes = import("../../isolate/NodeFsBackend.ts").NodeFsBackend["setTimes"];
