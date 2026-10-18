import type { CreateOptions, Inode, Times } from "../storage.ts";
import type { PosixMetadata } from "../PosixStorage.ts";
import {
  RIGHTS,
  WasiDescriptorTable,
  type WasiDescriptor,
} from "../wasi/internal_wasi_descriptors.ts";
import type {
  WasiPathLookup,
  WasiResolvedParent,
  WasiResolvedPath,
} from "../wasi/internal_wasi_paths.ts";
import { descriptorPathAlias } from "./KernelPathAliases.ts";
import { kernelError, runKernelSync, withKernelErrors } from "./KernelFileSystemErrors.ts";
import { KernelPathResolver, type ResolveOptions } from "./KernelPathResolver.ts";
import type { KernelStat } from "./KernelFileSystemTypes.ts";
import { KernelPosix } from "./KernelPosix.ts";
import { deviceInfoForDescriptor, deviceStat, virtualDevice } from "./KernelVirtualDevices.ts";

const encoder = new TextEncoder();

export class KernelFileSystemPaths {
  readonly resolver: KernelPathResolver;
  readonly #descriptors: WasiDescriptorTable;
  readonly #posix: KernelPosix;

  constructor(resolver: KernelPathResolver, descriptors: WasiDescriptorTable, posix: KernelPosix) {
    this.resolver = resolver;
    this.#descriptors = descriptors;
    this.#posix = posix;
  }

  get cwd(): string {
    return this.resolver.cwd;
  }

  resolve(path: string, options: ResolveOptions = {}): WasiResolvedPath {
    return withKernelErrors(() => {
      if (virtualDevice(path) !== undefined)
        throw kernelError("ENOTSUP", "Virtual device has no storage path");
      const alias = descriptorPathAlias(path);
      if (alias !== undefined) {
        if (options.followFinal === false)
          throw kernelError("ENOTSUP", "Magic links are not storage paths");
        return this.resolver.resolvedDescriptor(this.#getAlias(alias));
      }

      const followFinal = options.followFinal ?? true;
      if (followFinal) this.#checkFinalAbsoluteSymlink(path, options.cwd);
      return this.resolver.resolve(path, options);
    });
  }

  resolveOrCreate(path: string, options: ResolveOptions = {}): WasiPathLookup {
    return withKernelErrors(() => {
      this.#rejectVirtualMutation(path);
      const followFinal = options.followFinal ?? true;
      if (followFinal) this.#checkFinalAbsoluteSymlink(path, options.cwd);
      return this.resolver.resolveOrCreate(path, options);
    });
  }

  resolveParent(
    path: string,
    options: Omit<ResolveOptions, "followFinal"> = {},
  ): WasiResolvedParent {
    return withKernelErrors(() => {
      this.#rejectVirtualMutation(path);
      return this.resolver.resolveParent(path, options);
    });
  }

  stat(path: string): KernelStat {
    return withKernelErrors(() => {
      const device = virtualDevice(path);
      if (device !== undefined) return deviceStat(device);
      const alias = descriptorPathAlias(path);
      if (alias !== undefined) return this.#statDescriptor(this.#getAlias(alias));
      return this.#statResolved(this.resolve(path));
    });
  }

  lstat(path: string): KernelStat {
    return withKernelErrors(() => {
      const device = virtualDevice(path);
      if (device !== undefined) return deviceStat(device);
      const alias = descriptorPathAlias(path);
      if (alias !== undefined) return this.#statMagicLink(alias, this.#getAlias(alias));
      return this.#statResolved(this.resolver.resolve(path, { followFinal: false }));
    });
  }

  fstat(fd: number): KernelStat {
    return withKernelErrors(() => this.#statDescriptor(this.#descriptors.get(fd)));
  }

  realpath(path: string): string {
    return withKernelErrors(() => {
      const device = virtualDevice(path);
      if (device !== undefined) return path;
      const alias = descriptorPathAlias(path);
      if (alias !== undefined) return this.resolver.descriptorPath(this.#getAlias(alias));
      return this.resolver.guestPath(this.resolve(path));
    });
  }

  chdir(path: string): void {
    withKernelErrors(() => {
      const resolved = this.resolve(path);
      if (resolved.stat.type !== "directory") throw kernelError("ENOTDIR");
      this.resolver.setCwd(this.resolver.guestPath(resolved));
    });
  }

  fchdir(fd: number): void {
    withKernelErrors(() => this.resolver.setCwdFromDescriptor(fd));
  }

  readdir(path: string): string[] {
    return withKernelErrors(() => {
      if (virtualDevice(path) !== undefined) throw kernelError("ENOTDIR");
      const resolved = this.resolve(path);
      if (resolved.stat.type !== "directory") throw kernelError("ENOTDIR");
      return runKernelSync(resolved.mount.storage.readdir(resolved.inode)).map(
        (entry) => entry.name,
      );
    });
  }

  readlink(path: string): string {
    return withKernelErrors(() => {
      const alias = descriptorPathAlias(path);
      if (alias !== undefined) return this.resolver.descriptorPath(this.#getAlias(alias));
      if (virtualDevice(path) !== undefined) throw kernelError("EINVAL");
      const resolved = this.resolver.resolve(path, { followFinal: false });
      if (resolved.stat.type !== "symlink") throw kernelError("EINVAL");
      return runKernelSync(resolved.mount.storage.readlink(resolved.inode));
    });
  }

  createInode(
    mount: WasiResolvedPath["mount"],
    parent: Inode,
    name: string,
    options: CreateOptions,
    mode?: number,
  ): Inode {
    return this.#posix.createInode(mount, parent, name, options, mode);
  }

  getPosixMetadata(path: string, follow = true): PosixMetadata {
    const resolved = this.resolve(path, { followFinal: follow });
    return this.#posix.getMetadata(resolved.mount.storage, resolved.inode);
  }

  getPosixMetadataForFd(fd: number): PosixMetadata {
    const descriptor = this.#descriptors.get(fd);
    if (descriptor.mount === undefined || descriptor.inode === undefined) {
      throw kernelError("ENOTSUP");
    }
    return this.#posix.getMetadata(descriptor.mount.storage, descriptor.inode);
  }

  chmod(path: string, mode: number, follow = true): void {
    const resolved = this.resolve(path, { followFinal: follow });
    this.#posix.chmod(resolved.mount, resolved.inode, mode);
  }

  fchmod(fd: number, mode: number): void {
    const descriptor = this.#descriptors.get(fd);
    if (descriptor.mount === undefined || descriptor.inode === undefined) {
      throw kernelError("ENOTSUP");
    }
    this.#posix.chmod(descriptor.mount, descriptor.inode, mode);
  }

  chown(path: string, uid: number, gid: number, follow = true): void {
    const resolved = this.resolve(path, { followFinal: follow });
    this.#posix.chown(resolved.mount, resolved.inode, uid, gid);
  }

  fchown(fd: number, uid: number, gid: number): void {
    const descriptor = this.#descriptors.get(fd);
    if (descriptor.mount === undefined || descriptor.inode === undefined) {
      throw kernelError("ENOTSUP");
    }
    this.#posix.chown(descriptor.mount, descriptor.inode, uid, gid);
  }

  mkdir(path: string, mode = 0o777): void {
    withKernelErrors(() => {
      const parent = this.resolveParent(path);
      this.#assertWritable(parent.mount);
      const inode = this.createInode(
        parent.mount,
        parent.parent,
        parent.name,
        { type: "directory", exclusive: true },
        mode,
      );
      runKernelSync(parent.mount.storage.release(inode));
    });
  }

  symlink(target: string, path: string): void {
    withKernelErrors(() => {
      const parent = this.resolveParent(path);
      this.#assertWritable(parent.mount);
      if (target.startsWith("/"))
        this.#assertAbsoluteTarget(target, parent.mount.id, parent.mount.path);
      const inode = this.createInode(
        parent.mount,
        parent.parent,
        parent.name,
        {
          type: "symlink",
          exclusive: true,
          target,
        },
        0o777,
      );
      runKernelSync(parent.mount.storage.release(inode));
    });
  }

  link(sourcePath: string, targetPath: string): void {
    withKernelErrors(() => {
      const source = this.resolve(sourcePath, { followFinal: false });
      const target = this.resolveParent(targetPath);
      this.#assertWritable(target.mount);
      if (source.mount.id !== target.mount.id) throw kernelError("EXDEV");
      runKernelSync(source.mount.storage.link(source.inode, target.parent, target.name));
    });
  }

  rename(sourcePath: string, targetPath: string): void {
    withKernelErrors(() => {
      const source = this.resolveParent(sourcePath);
      const target = this.resolveParent(targetPath);
      this.#assertWritable(source.mount);
      this.#assertWritable(target.mount);
      if (source.mount.id !== target.mount.id) throw kernelError("EXDEV");
      runKernelSync(
        source.mount.storage.rename(source.parent, source.name, target.parent, target.name),
      );
    });
  }

  unlink(path: string): void {
    withKernelErrors(() => {
      const parent = this.resolveParent(path);
      this.#assertWritable(parent.mount);
      const inode = runKernelSync(parent.mount.storage.lookup(parent.parent, parent.name));
      if (runKernelSync(parent.mount.storage.stat(inode)).type === "directory")
        throw kernelError("EISDIR");
      runKernelSync(parent.mount.storage.unlink(parent.parent, parent.name, { directory: false }));
    });
  }

  rmdir(path: string): void {
    withKernelErrors(() => {
      const parent = this.resolveParent(path);
      this.#assertWritable(parent.mount);
      const inode = runKernelSync(parent.mount.storage.lookup(parent.parent, parent.name));
      if (runKernelSync(parent.mount.storage.stat(inode)).type !== "directory")
        throw kernelError("ENOTDIR");
      runKernelSync(parent.mount.storage.unlink(parent.parent, parent.name, { directory: true }));
    });
  }

  truncate(path: string, size: bigint): void {
    withKernelErrors(() => {
      if (virtualDevice(path) !== undefined) throw kernelError("ENOTSUP");
      const resolved = this.resolve(path);
      this.#assertWritable(resolved.mount);
      this.#truncate(resolved.mount, resolved.inode, resolved.stat.type, size);
    });
  }

  setTimes(path: string, times: Times, follow = true): void {
    withKernelErrors(() => {
      if (virtualDevice(path) !== undefined) throw kernelError("ENOTSUP");
      const resolved = this.resolve(path, { followFinal: follow });
      this.#assertWritable(resolved.mount);
      runKernelSync(resolved.mount.storage.setTimes(resolved.inode, times));
    });
  }

  fsetTimes(fd: number, times: Times): void {
    withKernelErrors(() => {
      const descriptor = this.#descriptors.get(fd);
      if ((descriptor.rightsBase & RIGHTS.FD_FILESTAT_SET_TIMES) === 0n) throw kernelError("EBADF");
      if (descriptor.kind === "stdio") throw kernelError("ENOTSUP");
      if (descriptor.mount === undefined || descriptor.inode === undefined)
        throw kernelError("EBADF");
      this.#assertWritable(descriptor.mount);
      runKernelSync(descriptor.mount.storage.setTimes(descriptor.inode, times));
    });
  }

  #statResolved(resolved: WasiResolvedPath): KernelStat {
    return { ...resolved.stat, ino: resolved.inode, dev: resolved.mount.device };
  }

  #statDescriptor(descriptor: WasiDescriptor): KernelStat {
    const device = deviceInfoForDescriptor(descriptor);
    if (device !== undefined) return deviceStat(device);
    if (descriptor.kind === "stdio") throw kernelError("ENOTSUP", "Stream stat is unsupported");
    return this.#statResolved(this.resolver.resolvedDescriptor(descriptor));
  }

  #statMagicLink(fd: number, descriptor: WasiDescriptor): KernelStat {
    const target = this.resolver.descriptorPath(descriptor);
    return {
      type: "symlink",
      size: BigInt(encoder.encode(target).byteLength),
      nlink: 1n,
      atimeNs: 0n,
      mtimeNs: 0n,
      ctimeNs: 0n,
      ino: (1n << 32n) + BigInt(fd),
      dev: (1n << 32n) - 1n,
    };
  }

  #getAlias(fd: number): WasiDescriptor {
    try {
      return withKernelErrors(() => this.#descriptors.get(fd));
    } catch (error) {
      if (isCode(error, "EBADF")) throw kernelError("ENOENT");
      throw error;
    }
  }

  #rejectVirtualMutation(path: string): void {
    if (virtualDevice(path) !== undefined || descriptorPathAlias(path) !== undefined) {
      throw kernelError("ENOTSUP", "Virtual devices and descriptor aliases are not mutable paths");
    }
  }

  #assertAbsoluteTarget(
    target: string,
    destinationMountId: number,
    destinationMountPath: string,
  ): void {
    if (destinationMountPath !== "/") {
      throw kernelError("ENOTSUP", "Absolute symlinks are unsupported on nested mounts");
    }
    const targetMount = this.resolver.mountForPath(target);
    if (targetMount.id !== destinationMountId) {
      throw kernelError("ENOTSUP", "Absolute symlink crosses a mount boundary");
    }
  }

  #checkFinalAbsoluteSymlink(path: string, cwd?: string): void {
    const lookup = this.resolver.resolveOrCreate(path, {
      followFinal: false,
      ...(cwd === undefined ? {} : { cwd }),
    });
    if (lookup.kind === "missing" || lookup.path.stat.type !== "symlink") return;
    const unresolved = lookup.path;
    const target = runKernelSync(unresolved.mount.storage.readlink(unresolved.inode));
    if (target.startsWith("/")) {
      this.#assertAbsoluteTarget(target, unresolved.mount.id, unresolved.mount.path);
    }
  }

  #assertWritable(mount: { readonly readOnly: boolean }): void {
    if (mount.readOnly) throw kernelError("EROFS");
  }

  #truncate(
    mount: WasiResolvedPath["mount"],
    inode: Inode,
    type: WasiResolvedPath["stat"]["type"],
    size: bigint,
  ): void {
    if (type === "directory") throw kernelError("EISDIR");
    if (type !== "file") throw kernelError("EINVAL");
    runKernelSync(mount.storage.truncate(inode, size));
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
