// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { CreateOptions, Inode } from "../storage.ts";
import { WasiError, WasiMemory } from "./internal_wasi_memory.ts";
import { complete, type WasiCall } from "./internal_wasi_calls.ts";
import {
  ALL_RIGHTS,
  FDFLAGS,
  READ_ONLY_RIGHTS,
  RIGHTS,
  type WasiDescriptor,
  WasiDescriptorTable,
} from "./internal_wasi_descriptors.ts";
import {
  type WasiMountedStorage,
  type WasiPathAnchor,
  type WasiResolvedPath,
  WasiPathResolver,
} from "./internal_wasi_paths.ts";
import { readTimes, writeFilestat } from "./internal_wasi_fd_calls.ts";
import {
  bindFileByteAccess,
  canonicalFileByteSelection,
  type KernelFileByteAccess,
  type KernelFileByteSelection,
  type KernelFileByteView,
} from "../KernelFileBytes.ts";

type WasiPathDirectoryDescriptor = WasiDescriptor & {
  readonly kind: "directory";
  readonly mount: WasiMountedStorage;
  readonly inode: Inode;
  readonly capabilityRoot: Inode;
};

const EEXIST = 20;
const EINVAL = 28;
const ELOOP = 32;
const EISDIR = 31;
const ENAMETOOLONG = 37;
const ENOENT = 44;
const ENOTDIR = 54;
const ENOTSUP = 58;
const EROFS = 69;
const EXDEV = 75;
const ENOTCAPABLE = 76;

const MAX_PATH_TRANSFER = 16 * 1024 * 1024;
const encoder = new TextEncoder();

const OFLAGS = { CREATE: 1, DIRECTORY: 2, EXCLUSIVE: 4, TRUNCATE: 8 } as const;
const DIRFLAGS_SYMLINK_FOLLOW = 1;

export interface WasiCreationPolicy {
  readonly createInode: (
    mount: WasiMountedStorage,
    parent: Inode,
    name: string,
    options: CreateOptions,
    mode?: number,
  ) => Inode | Promise<Inode>;
  readonly takeCreateMode: () => number | undefined;
}

export class WasiPathCalls {
  readonly #memory: WasiMemory;
  readonly #descriptors: WasiDescriptorTable;
  readonly #paths: WasiPathResolver;
  readonly #creation: WasiCreationPolicy | undefined;
  readonly #fileBytes: (() => KernelFileByteSelection) | undefined;

  readonly imports = {
    path_create_directory: (fd: number, path: number, pathLen: number): WasiCall<number> =>
      this.pathCreateDirectory(fd, path, pathLen),
    path_filestat_get: (
      fd: number,
      flags: number,
      path: number,
      pathLen: number,
      output: number,
    ): WasiCall<number> => this.pathFilestatGet(fd, flags, path, pathLen, output),
    path_filestat_set_times: (
      fd: number,
      flags: number,
      path: number,
      pathLen: number,
      atim: bigint,
      mtim: bigint,
      fstflags: number,
    ): WasiCall<number> =>
      this.pathFilestatSetTimes(fd, flags, path, pathLen, atim, mtim, fstflags),
    path_link: (
      oldFd: number,
      oldFlags: number,
      oldPath: number,
      oldPathLen: number,
      newFd: number,
      newPath: number,
      newPathLen: number,
    ): WasiCall<number> =>
      this.pathLink(oldFd, oldFlags, oldPath, oldPathLen, newFd, newPath, newPathLen),
    path_open: (
      fd: number,
      dirflags: number,
      path: number,
      pathLen: number,
      oflags: number,
      rightsBase: bigint,
      rightsInheriting: bigint,
      fdflags: number,
      openedFd: number,
    ): WasiCall<number> =>
      this.pathOpen(
        fd,
        dirflags,
        path,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFd,
      ),
    path_readlink: (
      fd: number,
      path: number,
      pathLen: number,
      buffer: number,
      bufferLen: number,
      bufused: number,
    ): WasiCall<number> => this.pathReadlink(fd, path, pathLen, buffer, bufferLen, bufused),
    path_remove_directory: (fd: number, path: number, pathLen: number): WasiCall<number> =>
      this.pathRemoveDirectory(fd, path, pathLen),
    path_rename: (
      oldFd: number,
      oldPath: number,
      oldPathLen: number,
      newFd: number,
      newPath: number,
      newPathLen: number,
    ): WasiCall<number> => this.pathRename(oldFd, oldPath, oldPathLen, newFd, newPath, newPathLen),
    path_symlink: (
      oldPath: number,
      oldPathLen: number,
      fd: number,
      newPath: number,
      newPathLen: number,
    ): WasiCall<number> => this.pathSymlink(oldPath, oldPathLen, fd, newPath, newPathLen),
    path_unlink_file: (fd: number, path: number, pathLen: number): WasiCall<number> =>
      this.pathUnlinkFile(fd, path, pathLen),
  };

  constructor(
    memory: WasiMemory,
    descriptors: WasiDescriptorTable,
    paths: WasiPathResolver,
    creation?: WasiCreationPolicy,
    fileBytes?: () => KernelFileByteSelection,
  ) {
    this.#memory = memory;
    this.#descriptors = descriptors;
    this.#paths = paths;
    this.#creation = creation;
    this.#fileBytes = fileBytes;
  }

  *pathCreateDirectory(fd: number, pathPointer: number, pathLength: number): WasiCall<number> {
    const mode = this.#creation?.takeCreateMode();
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_CREATE_DIRECTORY);
    this.#requireWritable(directory.mount);
    const path = this.#readPath(pathPointer, pathLength);
    const target = yield* this.#paths.resolveParent(this.#anchor(directory), path);
    const inode = yield* complete(
      this.#createInode(
        target.mount,
        target.parent,
        target.name,
        {
          type: "directory",
          exclusive: true,
        },
        mode,
      ),
    );
    yield* complete(target.mount.storage.release(inode));
    return 0;
  }

  *pathFilestatGet(
    fd: number,
    flags: number,
    pathPointer: number,
    pathLength: number,
    output: number,
  ): WasiCall<number> {
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_FILESTAT_GET);
    validateDirFlags(flags);
    this.#memory.range(output, 64);
    const path = this.#readPath(pathPointer, pathLength);
    const resolved = yield* this.#paths.resolve(
      this.#anchor(directory),
      path,
      (flags & DIRFLAGS_SYMLINK_FOLLOW) !== 0,
    );
    let stat = resolved.stat;
    if (stat.type === "file") {
      const access = bindFileByteAccess(this.#selection(), resolved.mount.storage, resolved.inode);
      if (access !== undefined) {
        try {
          stat = { ...stat, size: access.stat().size };
        } finally {
          access.release();
        }
      }
    }
    writeFilestat(this.#memory, output, resolved.mount.device, resolved.inode, stat);
    return 0;
  }

  *pathFilestatSetTimes(
    fd: number,
    flags: number,
    pathPointer: number,
    pathLength: number,
    atim: bigint,
    mtim: bigint,
    fstflags: number,
  ): WasiCall<number> {
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_FILESTAT_SET_TIMES);
    this.#requireWritable(directory.mount);
    validateDirFlags(flags);
    const times = readTimes(atim, mtim, fstflags);
    const path = this.#readPath(pathPointer, pathLength);
    const resolved = yield* this.#paths.resolve(
      this.#anchor(directory),
      path,
      (flags & DIRFLAGS_SYMLINK_FOLLOW) !== 0,
    );
    yield* complete(resolved.mount.storage.setTimes(resolved.inode, times));
    return 0;
  }

  *pathLink(
    oldFd: number,
    oldFlags: number,
    oldPathPointer: number,
    oldPathLength: number,
    newFd: number,
    newPathPointer: number,
    newPathLength: number,
  ): WasiCall<number> {
    const sourceDirectory = this.#requireDirectory(oldFd, RIGHTS.PATH_LINK_SOURCE);
    const targetDirectory = this.#requireDirectory(newFd, RIGHTS.PATH_LINK_TARGET);
    this.#requireWritable(targetDirectory.mount);
    validateDirFlags(oldFlags);
    const oldPath = this.#readPath(oldPathPointer, oldPathLength);
    const newPath = this.#readPath(newPathPointer, newPathLength);
    const source = yield* this.#paths.resolve(
      this.#anchor(sourceDirectory),
      oldPath,
      (oldFlags & DIRFLAGS_SYMLINK_FOLLOW) !== 0,
    );
    const target = yield* this.#paths.resolveParent(this.#anchor(targetDirectory), newPath);
    if (source.mount.id !== target.mount.id) throw new WasiError(EXDEV);
    yield* complete(source.mount.storage.link(source.inode, target.parent, target.name));
    return 0;
  }

  *pathOpen(
    fd: number,
    dirflags: number,
    pathPointer: number,
    pathLength: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    openedFd: number,
  ): WasiCall<number> {
    const creationMode = this.#creation?.takeCreateMode();
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_OPEN);
    validateDirFlags(dirflags);
    validateOpenFlags(oflags, fdflags);
    if ((oflags & OFLAGS.CREATE) !== 0 && (oflags & OFLAGS.DIRECTORY) !== 0) {
      throw new WasiError(EINVAL);
    }
    if ((oflags & OFLAGS.TRUNCATE) !== 0) {
      this.#requireRight(directory, RIGHTS.PATH_FILESTAT_SET_SIZE);
    }
    if ((fdflags & FDFLAGS.DSYNC) !== 0) {
      this.#requireRight(directory, RIGHTS.FD_DATASYNC);
    }
    if ((fdflags & (FDFLAGS.RSYNC | FDFLAGS.SYNC)) !== 0) {
      this.#requireRight(directory, RIGHTS.FD_SYNC);
    }
    this.#memory.range(openedFd, 4);
    const baseRights = normalizeRights(rightsBase);
    const inheritingRights = normalizeRights(rightsInheriting);
    if (
      ((baseRights | inheritingRights) & ~ALL_RIGHTS) !== 0n ||
      (baseRights & ~directory.rightsInheriting) !== 0n ||
      (inheritingRights & ~directory.rightsInheriting) !== 0n
    ) {
      throw new WasiError(ENOTCAPABLE);
    }
    if (directory.mount.readOnly && ((baseRights | inheritingRights) & ~READ_ONLY_RIGHTS) !== 0n) {
      throw new WasiError(ENOTCAPABLE);
    }
    const path = this.#readPath(pathPointer, pathLength);
    const follow = (dirflags & DIRFLAGS_SYMLINK_FOLLOW) !== 0;
    const lookup = yield* this.#paths.resolveOrCreate(this.#anchor(directory), path, follow);
    let retained: { mount: WasiMountedStorage; inode: Inode } | undefined;
    let childFd: number | undefined;
    let byteAccess: KernelFileByteAccess | undefined;
    let byteView: KernelFileByteView | undefined;
    let resolved: WasiResolvedPath | undefined;
    try {
      let inode: Inode;
      if (lookup.kind === "missing") {
        if ((oflags & OFLAGS.CREATE) === 0) throw new WasiError(ENOENT);
        this.#requireRight(directory, RIGHTS.PATH_CREATE_FILE);
        this.#requireWritable(directory.mount);
        inode = yield* complete(
          this.#createInode(
            lookup.parent.mount,
            lookup.parent.parent,
            lookup.parent.name,
            {
              type: "file",
              exclusive: (oflags & OFLAGS.EXCLUSIVE) !== 0,
            },
            creationMode,
          ),
        );
        retained = { mount: lookup.parent.mount, inode };
        const stat = yield* complete(lookup.parent.mount.storage.stat(inode));
        resolved = {
          mount: lookup.parent.mount,
          inode,
          stat,
          parent: lookup.parent.parent,
          name: lookup.parent.name,
          pathComponents: lookup.parent.pathComponents,
          ancestors: lookup.parent.ancestors,
        };
      } else {
        resolved = lookup.path;
        if ((oflags & OFLAGS.CREATE) !== 0 && (oflags & OFLAGS.EXCLUSIVE) !== 0) {
          throw new WasiError(EEXIST);
        }
        if (resolved.stat.type === "symlink" && !follow) throw new WasiError(ELOOP);
        if ((oflags & OFLAGS.DIRECTORY) !== 0 && resolved.stat.type !== "directory") {
          throw new WasiError(ENOTDIR);
        }
        inode = resolved.inode;
        yield* complete(resolved.mount.storage.retain(inode));
        retained = { mount: resolved.mount, inode };
      }

      const truncate = (oflags & OFLAGS.TRUNCATE) !== 0;
      if (truncate) {
        this.#requireWritable(resolved.mount);
        if (resolved.stat.type !== "file") {
          throw new WasiError(resolved.stat.type === "directory" ? EISDIR : EINVAL);
        }
      }
      if (resolved.stat.type === "file") {
        const selection = this.#selection();
        byteAccess = bindFileByteAccess(selection, resolved.mount.storage, inode);
        if (byteAccess !== undefined && selection.kind === "view") byteView = selection.view;
      }
      if (truncate) {
        if (byteAccess !== undefined) {
          byteAccess.truncate(0n);
        } else {
          yield* complete(resolved.mount.storage.truncate(inode, 0n));
        }
      }
      childFd = this.#descriptors.allocate({
        kind: resolved.stat.type,
        mount: resolved.mount,
        inode,
        capabilityRoot: directory.capabilityRoot,
        ancestors: [...resolved.ancestors],
        pathComponents: [...resolved.pathComponents],
        offset: 0n,
        rightsBase: baseRights,
        rightsInheriting: inheritingRights,
        flags: fdflags,
        ...(byteAccess === undefined ? {} : { byteAccess }),
        ...(byteView === undefined ? {} : { byteView }),
      });
      retained = undefined;
      this.#memory.u32(openedFd, childFd);
      return 0;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (childFd !== undefined) {
        try {
          yield* this.#descriptors.close(childFd);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      } else {
        if (byteAccess !== undefined) {
          try {
            byteAccess.release();
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (retained !== undefined) {
          try {
            yield* complete(retained.mount.storage.release(retained.inode));
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "WASI open and cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  *pathReadlink(
    fd: number,
    pathPointer: number,
    pathLength: number,
    buffer: number,
    bufferLen: number,
    bufused: number,
  ): WasiCall<number> {
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_READLINK);
    const capacity = bufferLen >>> 0;
    this.#memory.validateRange(buffer, capacity);
    this.#memory.range(bufused, 4);
    const path = this.#readPath(pathPointer, pathLength);
    const resolved = yield* this.#paths.resolve(this.#anchor(directory), path, false);
    if (resolved.stat.type !== "symlink") throw new WasiError(EINVAL);
    const target = yield* complete(resolved.mount.storage.readlink(resolved.inode));
    const encoded = encoder.encode(target);
    const used = Math.min(
      capacity,
      encoded.byteLength,
      MAX_PATH_TRANSFER,
      // signalbox: the readlink reply is a child transfer, so it fits the owner-issued credit.
      this.#memory.transferLimit,
    );
    this.#memory.writeRange(buffer, used).set(encoded.subarray(0, used));
    this.#memory.u32(bufused, used);
    return 0;
  }

  *pathRemoveDirectory(fd: number, pathPointer: number, pathLength: number): WasiCall<number> {
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_REMOVE_DIRECTORY);
    this.#requireWritable(directory.mount);
    const path = this.#readPath(pathPointer, pathLength);
    const target = yield* this.#paths.resolveParent(this.#anchor(directory), path);
    const inode = yield* complete(target.mount.storage.lookup(target.parent, target.name));
    const stat = yield* complete(target.mount.storage.stat(inode));
    if (stat.type !== "directory") throw new WasiError(ENOTDIR);
    yield* complete(
      target.mount.storage.unlink(target.parent, target.name, {
        directory: true,
      }),
    );
    return 0;
  }

  *pathRename(
    oldFd: number,
    oldPathPointer: number,
    oldPathLength: number,
    newFd: number,
    newPathPointer: number,
    newPathLength: number,
  ): WasiCall<number> {
    const sourceDirectory = this.#requireDirectory(oldFd, RIGHTS.PATH_RENAME_SOURCE);
    const targetDirectory = this.#requireDirectory(newFd, RIGHTS.PATH_RENAME_TARGET);
    this.#requireWritable(sourceDirectory.mount);
    this.#requireWritable(targetDirectory.mount);
    const oldPath = this.#readPath(oldPathPointer, oldPathLength);
    const newPath = this.#readPath(newPathPointer, newPathLength);
    const source = yield* this.#paths.resolveParent(this.#anchor(sourceDirectory), oldPath);
    const target = yield* this.#paths.resolveParent(this.#anchor(targetDirectory), newPath);
    if (source.mount.id !== target.mount.id) throw new WasiError(EXDEV);
    const sourceInode = yield* complete(source.mount.storage.lookup(source.parent, source.name));
    const sourceStat = yield* complete(source.mount.storage.stat(sourceInode));
    if (
      sourceStat.type === "directory" &&
      target.pathComponents.length > source.pathComponents.length &&
      source.pathComponents.every((component, index) => target.pathComponents[index] === component)
    ) {
      throw new WasiError(EINVAL);
    }
    yield* complete(
      source.mount.storage.rename(source.parent, source.name, target.parent, target.name),
    );
    return 0;
  }

  *pathSymlink(
    oldPathPointer: number,
    oldPathLength: number,
    fd: number,
    newPathPointer: number,
    newPathLength: number,
  ): WasiCall<number> {
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_SYMLINK);
    this.#requireWritable(directory.mount);
    const target = this.#readPath(oldPathPointer, oldPathLength);
    const newPath = this.#readPath(newPathPointer, newPathLength);
    const parent = yield* this.#paths.resolveParent(this.#anchor(directory), newPath);
    const inode = yield* complete(
      this.#createInode(parent.mount, parent.parent, parent.name, {
        type: "symlink",
        exclusive: true,
        target,
      }),
    );
    yield* complete(parent.mount.storage.release(inode));
    return 0;
  }

  *pathUnlinkFile(fd: number, pathPointer: number, pathLength: number): WasiCall<number> {
    const directory = this.#requireDirectory(fd, RIGHTS.PATH_UNLINK_FILE);
    this.#requireWritable(directory.mount);
    const path = this.#readPath(pathPointer, pathLength);
    const target = yield* this.#paths.resolveParent(this.#anchor(directory), path);
    const inode = yield* complete(target.mount.storage.lookup(target.parent, target.name));
    const stat = yield* complete(target.mount.storage.stat(inode));
    if (stat.type === "directory") throw new WasiError(EISDIR);
    yield* complete(
      target.mount.storage.unlink(target.parent, target.name, {
        directory: false,
      }),
    );
    return 0;
  }

  #createInode(
    mount: WasiMountedStorage,
    parent: Inode,
    name: string,
    options: CreateOptions,
    mode?: number,
  ): Inode | Promise<Inode> {
    return this.#creation === undefined
      ? mount.storage.create(parent, name, options)
      : this.#creation.createInode(mount, parent, name, options, mode);
  }

  #selection(): KernelFileByteSelection {
    return this.#fileBytes?.() ?? canonicalFileByteSelection;
  }

  #anchor(descriptor: WasiPathDirectoryDescriptor): WasiPathAnchor {
    return {
      mount: descriptor.mount,
      inode: descriptor.inode,
      ancestors: descriptor.ancestors ?? [descriptor.inode],
      pathComponents: descriptor.pathComponents ?? [],
    };
  }

  #requireDirectory(fd: number, right: bigint): WasiPathDirectoryDescriptor {
    const descriptor = this.#descriptors.get(fd);
    this.#requireRight(descriptor, right);
    return this.#requirePathDirectory(descriptor);
  }

  #requirePathDirectory(descriptor: WasiDescriptor): WasiPathDirectoryDescriptor {
    if (
      descriptor.kind !== "directory" ||
      descriptor.mount === undefined ||
      descriptor.inode === undefined ||
      descriptor.capabilityRoot === undefined
    ) {
      throw new WasiError(ENOTDIR);
    }
    return descriptor as WasiPathDirectoryDescriptor;
  }

  #requireRight(descriptor: WasiDescriptor, right: bigint): void {
    if ((descriptor.rightsBase & right) !== right) throw new WasiError(ENOTCAPABLE);
  }

  #requireWritable(mount: WasiMountedStorage): void {
    if (mount.readOnly) throw new WasiError(EROFS);
  }

  #readPath(pointer: number, length: number): string {
    const size = length >>> 0;
    if (size > MAX_PATH_TRANSFER) throw new WasiError(ENAMETOOLONG);
    return this.#memory.string(pointer, size);
  }
}

function validateDirFlags(flags: number): void {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~DIRFLAGS_SYMLINK_FOLLOW) !== 0) {
    throw new WasiError(EINVAL);
  }
}

function validateOpenFlags(oflags: number, fdflags: number): void {
  if (!Number.isInteger(oflags) || oflags < 0 || (oflags & ~15) !== 0) {
    throw new WasiError(EINVAL);
  }
  if (!Number.isInteger(fdflags) || fdflags < 0 || (fdflags & ~31) !== 0) {
    throw new WasiError(EINVAL);
  }
}

function normalizeRights(rights: bigint): bigint {
  return BigInt.asUintN(64, rights);
}
