import { complete, runSync, type WasiCall } from "../wasi/internal_wasi_calls.ts";
import { withKernelFileWrite } from "../KernelIoLock.ts";
import {
  canonicalFileByteSelection,
  bindFileByteAccess,
  type KernelFileByteSelection,
} from "../KernelFileBytes.ts";
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
  WasiPathSearchCheck,
} from "../wasi/internal_wasi_paths.ts";
import { descriptorPathAlias } from "./KernelPathAliases.ts";
import {
  kernelError,
  runKernelSync,
  withKernelErrors,
  withKernelErrorsAsync,
} from "./KernelFileSystemErrors.ts";
import { KernelPathResolver, type ResolveOptions } from "./KernelPathResolver.ts";
import type { KernelStat } from "./KernelFileSystemTypes.ts";
import { KernelPosix } from "./KernelPosix.ts";
import { kernelLowerNativeMetadata } from "../KernelLowerFileSystemStorage.ts";
import { deviceInfoForDescriptor, deviceStat, virtualDevice } from "./KernelVirtualDevices.ts";

const encoder = new TextEncoder();

export class KernelFileSystemPaths {
  readonly resolver: KernelPathResolver;
  readonly #descriptors: WasiDescriptorTable;
  readonly #posix: KernelPosix;
  readonly #fileBytes: () => KernelFileByteSelection;

  constructor(
    resolver: KernelPathResolver,
    descriptors: WasiDescriptorTable,
    posix: KernelPosix,
    fileBytes: () => KernelFileByteSelection = () => canonicalFileByteSelection,
  ) {
    this.resolver = resolver;
    this.#descriptors = descriptors;
    this.#posix = posix;
    this.#fileBytes = fileBytes;
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
      if (followFinal) this.#checkFinalAbsoluteSymlink(path, options);
      return this.resolver.resolve(path, options);
    });
  }

  resolveOrCreate(path: string, options: ResolveOptions = {}): WasiPathLookup {
    return withKernelErrors(() => {
      this.#rejectVirtualMutation(path);
      const followFinal = options.followFinal ?? true;
      if (followFinal) this.#checkFinalAbsoluteSymlink(path, options);
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
    return withKernelErrors(() => runSync(this.#statPath(path, true, false)));
  }

  statAsync(path: string, followFinal = true): Promise<KernelStat> {
    return withKernelErrorsAsync(() =>
      this.resolver.runAsync(this.#statPath(path, followFinal, true)),
    );
  }

  checkExecutable(path: string): Promise<KernelStat> {
    return withKernelErrorsAsync(async () => {
      if (virtualDevice(path) !== undefined || descriptorPathAlias(path) !== undefined) {
        const stat = this.stat(path);
        this.access(path, 1, true);
        return stat;
      }
      const options = this.#searchOptionsAsync(true);
      await this.#checkFinalAbsoluteSymlinkAsync(path, options);
      const resolved = await this.resolver.resolveAsync(path, options);
      const metadata = await this.#posix.checkAccessAsync(
        resolved.mount.storage,
        resolved.inode,
        resolved.stat.type,
        1,
        true,
      );
      return this.#statResolvedWithMetadata(resolved, undefined, metadata);
    });
  }

  lstat(path: string): KernelStat {
    return withKernelErrors(() => runSync(this.#statPath(path, false, false)));
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
    return withKernelErrors(() => runSync(this.#readDirectory(path, false)));
  }

  readdirAsync(path: string): Promise<string[]> {
    return withKernelErrorsAsync(() => this.resolver.runAsync(this.#readDirectory(path, true)));
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
    return withKernelErrors(() => {
      const descriptor = this.#descriptors.get(fd);
      if (descriptor.mount === undefined || descriptor.inode === undefined) {
        throw kernelError("ENOTSUP");
      }
      return this.#posix.getMetadata(descriptor.mount.storage, descriptor.inode);
    });
  }

  chmod(path: string, mode: number, follow = true): void {
    const resolved = this.resolve(path, { followFinal: follow });
    this.#posix.chmod(resolved.mount, resolved.inode, mode);
  }

  fchmod(fd: number, mode: number): void {
    withKernelErrors(() => {
      const descriptor = this.#metadataDescriptor(fd);
      this.#posix.chmod(descriptor.mount, descriptor.inode, mode);
    });
  }

  chown(path: string, uid: number, gid: number, follow = true): void {
    const resolved = this.resolve(path, { followFinal: follow });
    this.#posix.chown(resolved.mount, resolved.inode, uid, gid);
  }

  fchown(fd: number, uid: number, gid: number): void {
    withKernelErrors(() => {
      const descriptor = this.#metadataDescriptor(fd);
      this.#posix.chown(descriptor.mount, descriptor.inode, uid, gid);
    });
  }

  access(path: string, mode: number, effectiveIds = false): void {
    if (!Number.isInteger(mode) || mode < 0 || (mode & ~7) !== 0) {
      throw kernelError("EINVAL");
    }
    const requested = mode;
    const alias = descriptorPathAlias(path);
    const virtualAlias =
      alias !== undefined && deviceInfoForDescriptor(this.#getAlias(alias)) !== undefined;
    if (
      this.#posix.credentials === undefined ||
      virtualDevice(path) !== undefined ||
      virtualAlias ||
      (alias !== undefined && requested === 0)
    ) {
      this.stat(path);
      if (requested !== 0) throw kernelError("ENOTSUP");
      return;
    }
    const resolved = this.resolve(path, this.#searchOptions(effectiveIds));

    if ((requested & 2) !== 0 && resolved.mount.readOnly) throw kernelError("EROFS");
    if (requested !== 0) {
      this.#posix.checkAccess(
        resolved.mount.storage,
        resolved.inode,
        resolved.stat.type,
        requested,
        effectiveIds,
      );
    }
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
      const alias = descriptorPathAlias(path);
      const descriptor = alias === undefined ? undefined : this.#getAlias(alias);
      this.#truncate(resolved.mount, resolved.inode, resolved.stat.type, size, descriptor);
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

  *#statPath(path: string, followFinal: boolean, asynchronous: boolean): WasiCall<KernelStat> {
    const device = virtualDevice(path);
    if (device !== undefined) return deviceStat(device);
    const alias = descriptorPathAlias(path);
    if (alias !== undefined)
      return followFinal
        ? this.#statDescriptor(this.#getAlias(alias))
        : this.#statMagicLink(alias, this.#getAlias(alias));
    const resolved = yield* this.#resolveReadPath(path, followFinal, asynchronous);
    return yield* this.#readStat(resolved, undefined, asynchronous);
  }

  *#readDirectory(path: string, asynchronous: boolean): WasiCall<string[]> {
    if (virtualDevice(path) !== undefined) throw kernelError("ENOTDIR");
    const resolved = yield* this.#resolveReadPath(path, true, asynchronous);
    if (resolved.stat.type !== "directory") throw kernelError("ENOTDIR");
    if (this.#posix.credentials !== undefined) {
      if (asynchronous)
        yield* complete(
          this.#posix.checkAccessAsync(
            resolved.mount.storage,
            resolved.inode,
            "directory",
            4,
            true,
          ),
        );
      else this.#posix.checkAccess(resolved.mount.storage, resolved.inode, "directory", 4, true);
    }
    return (yield* complete(resolved.mount.storage.readdir(resolved.inode))).map(
      (entry) => entry.name,
    );
  }

  *#resolveReadPath(
    path: string,
    followFinal: boolean,
    asynchronous: boolean,
  ): WasiCall<WasiResolvedPath> {
    if (!asynchronous || descriptorPathAlias(path) !== undefined)
      return this.resolve(path, { followFinal, ...this.#searchOptions(true) });
    const options = { followFinal, ...this.#searchOptionsAsync(true) };
    if (followFinal) yield* complete(this.#checkFinalAbsoluteSymlinkAsync(path, options));
    return yield* complete(this.resolver.resolveAsync(path, options));
  }

  #statResolved(resolved: WasiResolvedPath, descriptor?: WasiDescriptor): KernelStat {
    return runSync(this.#readStat(resolved, descriptor, false));
  }

  *#readStat(
    resolved: WasiResolvedPath,
    descriptor: WasiDescriptor | undefined,
    asynchronous: boolean,
  ): WasiCall<KernelStat> {
    let posix: PosixMetadata | undefined;
    try {
      // Keep inode metadata in the same syscall snapshot so async clients cannot mix replacements.
      posix = yield* complete(
        asynchronous
          ? this.#posix.getMetadataAsync(resolved.mount.storage, resolved.inode)
          : this.#posix.getMetadata(resolved.mount.storage, resolved.inode),
      );
    } catch (error) {
      if (!isCode(error, "ENOTSUP")) throw error;
    }
    return this.#statResolvedWithMetadata(resolved, descriptor, posix);
  }

  #statResolvedWithMetadata(
    resolved: WasiResolvedPath,
    descriptor: WasiDescriptor | undefined,
    posix: PosixMetadata | undefined,
  ): KernelStat {
    const temporary =
      resolved.stat.type === "file" && descriptor === undefined
        ? bindFileByteAccess(this.#fileBytes(), resolved.mount.storage, resolved.inode)
        : undefined;
    try {
      const stat = (descriptor?.byteAccess ?? temporary)?.stat() ?? resolved.stat;
      return {
        ...stat,
        ino: resolved.inode,
        dev: resolved.mount.device,
        ...kernelLowerNativeMetadata(resolved.mount.storage, resolved.inode),
        ...(posix === undefined ? {} : { posix }),
      };
    } finally {
      temporary?.release();
    }
  }

  #searchCheck(effectiveIds: boolean): WasiPathSearchCheck | undefined {
    if (this.#posix.credentials === undefined) return undefined;
    return (mount, directory) =>
      this.#posix.checkAccess(mount.storage, directory, "directory", 1, effectiveIds);
  }

  #searchOptions(effectiveIds: boolean): { readonly checkSearch?: WasiPathSearchCheck } {
    const checkSearch = this.#searchCheck(effectiveIds);
    return checkSearch === undefined ? {} : { checkSearch };
  }

  #searchCheckAsync(effectiveIds: boolean): WasiPathSearchCheck | undefined {
    if (this.#posix.credentials === undefined) return undefined;
    return async (mount, directory) => {
      await this.#posix.checkAccessAsync(mount.storage, directory, "directory", 1, effectiveIds);
    };
  }

  #searchOptionsAsync(effectiveIds: boolean): { readonly checkSearch?: WasiPathSearchCheck } {
    const checkSearch = this.#searchCheckAsync(effectiveIds);
    return checkSearch === undefined ? {} : { checkSearch };
  }

  #statDescriptor(descriptor: WasiDescriptor): KernelStat {
    const device = deviceInfoForDescriptor(descriptor);
    if (device !== undefined) return deviceStat(device);
    if (descriptor.kind === "stdio") throw kernelError("ENOTSUP", "Stream stat is unsupported");
    return this.#statResolved(this.resolver.resolvedDescriptor(descriptor), descriptor);
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

  #checkFinalAbsoluteSymlink(path: string, options: ResolveOptions): void {
    const lookup = this.resolver.resolveOrCreate(path, {
      ...options,
      followFinal: false,
    });
    if (lookup.kind === "missing" || lookup.path.stat.type !== "symlink") return;
    const unresolved = lookup.path;
    const target = runKernelSync(unresolved.mount.storage.readlink(unresolved.inode));
    if (target.startsWith("/")) {
      this.#assertAbsoluteTarget(target, unresolved.mount.id, unresolved.mount.path);
    }
  }

  async #checkFinalAbsoluteSymlinkAsync(path: string, options: ResolveOptions): Promise<void> {
    const lookup = await this.resolver.resolveOrCreateAsync(path, {
      ...options,
      followFinal: false,
    });
    if (lookup.kind === "missing" || lookup.path.stat.type !== "symlink") return;
    const unresolved = lookup.path;
    const target = await this.resolver.runAsync(
      complete(unresolved.mount.storage.readlink(unresolved.inode)),
    );
    if (target.startsWith("/")) {
      this.#assertAbsoluteTarget(target, unresolved.mount.id, unresolved.mount.path);
    }
  }

  #assertWritable(mount: { readonly readOnly: boolean }): void {
    if (mount.readOnly) throw kernelError("EROFS");
  }

  #metadataDescriptor(fd: number): WasiDescriptor & {
    readonly mount: NonNullable<WasiDescriptor["mount"]>;
    readonly inode: Inode;
  } {
    const descriptor = this.#descriptors.get(fd);
    if (descriptor.mount === undefined || descriptor.inode === undefined) {
      throw kernelError("EBADF");
    }
    this.#assertWritable(descriptor.mount);
    // There is no separate descriptor right for POSIX mode and owner changes.
    if ((descriptor.rightsBase & RIGHTS.FD_FILESTAT_SET_TIMES) !== RIGHTS.FD_FILESTAT_SET_TIMES) {
      throw kernelError("EBADF");
    }
    return descriptor as WasiDescriptor & {
      readonly mount: NonNullable<WasiDescriptor["mount"]>;
      readonly inode: Inode;
    };
  }

  #truncate(
    mount: WasiResolvedPath["mount"],
    inode: Inode,
    type: WasiResolvedPath["stat"]["type"],
    size: bigint,
    descriptor?: WasiDescriptor,
  ): void {
    if (type === "directory") throw kernelError("EISDIR");
    if (type !== "file") throw kernelError("EINVAL");
    if (size < 0n) throw kernelError("EINVAL");
    if (size > (1n << 63n) - 1n) throw kernelError("EFBIG");
    const temporary =
      descriptor === undefined
        ? bindFileByteAccess(this.#fileBytes(), mount.storage, inode)
        : undefined;
    try {
      const access = descriptor?.byteAccess ?? temporary;
      runSync(
        withKernelFileWrite(mount.storage, inode, () =>
          access ? access.truncate(size) : mount.storage.truncate(inode, size),
        ),
      );
    } finally {
      temporary?.release();
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
