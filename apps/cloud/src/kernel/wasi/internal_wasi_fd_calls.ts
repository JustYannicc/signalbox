// @effect-diagnostics globalDate:off - portable WASI host timestamps run without Effect.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/* eslint-disable require-yield -- WASI handlers share a generator protocol for immediate and suspending calls. */

import type { DirectoryEntry, Inode, Stat, Times } from "../storage.ts";
import { WasiError, WasiMemory } from "./internal_wasi_memory.ts";
import { complete, mapErrno, type WasiCall } from "./internal_wasi_calls.ts";
import type { WasiMountedStorage } from "./internal_wasi_paths.ts";
import {
  FDFLAGS,
  RIGHTS,
  type WasiDescriptor,
  WasiDescriptorTable,
} from "./internal_wasi_descriptors.ts";

const EBADF = 8;
const ENOTDIR = 54;

const EFBIG = 22;
const EINVAL = 28;
const EIO = 29;
const EISDIR = 31;
const ENAMETOOLONG = 37;
const ENOTSUP = 58;
const EOVERFLOW = 61;
const EROFS = 69;
const ESPIPE = 70;
const ENOTCAPABLE = 76;

const IO_CHUNK_BYTES = 64 * 1024;
const MAX_FILE_SIZE = (1n << 63n) - 1n;
const DIR_COOKIE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

type WasiStorageDescriptor = WasiDescriptor & {
  readonly kind: "file" | "directory" | "symlink";
  readonly mount: WasiMountedStorage;
  readonly inode: Inode;
};

export class WasiFdCalls {
  readonly #memory: WasiMemory;
  readonly #descriptors: WasiDescriptorTable;

  readonly imports = {
    fd_advise: (fd: number, offset: bigint, length: bigint, advice: number): WasiCall<number> =>
      this.fdAdvise(fd, offset, length, advice),
    fd_allocate: (fd: number, offset: bigint, length: bigint): WasiCall<number> =>
      this.fdAllocate(fd, offset, length),
    fd_close: (fd: number): WasiCall<number> => this.fdClose(fd),
    fd_datasync: (fd: number): WasiCall<number> => this.fdDatasync(fd),
    fd_fdstat_get: (fd: number, output: number): WasiCall<number> => this.fdFdstatGet(fd, output),
    fd_fdstat_set_flags: (fd: number, flags: number): WasiCall<number> =>
      this.fdFdstatSetFlags(fd, flags),
    fd_fdstat_set_rights: (fd: number, base: bigint, inheriting: bigint): WasiCall<number> =>
      this.fdFdstatSetRights(fd, base, inheriting),
    fd_filestat_get: (fd: number, output: number): WasiCall<number> =>
      this.fdFilestatGet(fd, output),
    fd_filestat_set_size: (fd: number, size: bigint): WasiCall<number> =>
      this.fdFilestatSetSize(fd, size),
    fd_filestat_set_times: (
      fd: number,
      atim: bigint,
      mtim: bigint,
      flags: number,
    ): WasiCall<number> => this.fdFilestatSetTimes(fd, atim, mtim, flags),
    fd_pread: (
      fd: number,
      iovs: number,
      iovsLen: number,
      offset: bigint,
      nread: number,
    ): WasiCall<number> => this.fdPread(fd, iovs, iovsLen, offset, nread),
    fd_pwrite: (
      fd: number,
      iovs: number,
      iovsLen: number,
      offset: bigint,
      nwritten: number,
    ): WasiCall<number> => this.fdPwrite(fd, iovs, iovsLen, offset, nwritten),
    fd_prestat_get: (fd: number, output: number): WasiCall<number> => this.fdPrestatGet(fd, output),
    fd_prestat_dir_name: (fd: number, path: number, pathLen: number): WasiCall<number> =>
      this.fdPrestatDirName(fd, path, pathLen),
    fd_read: (fd: number, iovs: number, iovsLen: number, nread: number): WasiCall<number> =>
      this.fdRead(fd, iovs, iovsLen, nread),
    fd_readdir: (
      fd: number,
      buffer: number,
      bufferLen: number,
      cookie: bigint,
      bufused: number,
    ): WasiCall<number> => this.fdReaddir(fd, buffer, bufferLen, cookie, bufused),
    fd_renumber: (from: number, to: number): WasiCall<number> => this.fdRenumber(from, to),
    fd_seek: (fd: number, offset: bigint, whence: number, newOffset: number): WasiCall<number> =>
      this.fdSeek(fd, offset, whence, newOffset),
    fd_sync: (fd: number): WasiCall<number> => this.fdSync(fd),
    fd_tell: (fd: number, offset: number): WasiCall<number> => this.fdTell(fd, offset),
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number): WasiCall<number> =>
      this.fdWrite(fd, iovs, iovsLen, nwritten),
  };

  constructor(memory: WasiMemory, descriptors: WasiDescriptorTable) {
    this.#memory = memory;
    this.#descriptors = descriptors;
  }

  *fdAdvise(fd: number, offset: bigint, length: bigint, advice: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    requireRight(descriptor, RIGHTS.FD_ADVISE);
    const start = normalizeU64(offset);
    const size = normalizeU64(length);
    if (start + size > MAX_FILE_SIZE) throw new WasiError(EOVERFLOW);
    if (!Number.isInteger(advice) || advice < 0 || advice > 5) throw new WasiError(EINVAL);
    return 0;
  }

  *fdAllocate(fd: number, offset: bigint, length: bigint): WasiCall<number> {
    const descriptor = this.#storageDescriptor(fd);
    requireRight(descriptor, RIGHTS.FD_ALLOCATE);
    this.#requireWritable(descriptor);
    const start = normalizeU64(offset);
    const size = normalizeU64(length);
    const end = start + size;
    if (end > MAX_FILE_SIZE) throw new WasiError(EFBIG);
    const stat = yield* this.#stat(descriptor);
    if (stat.type !== "file") throw new WasiError(stat.type === "directory" ? EISDIR : EINVAL);
    if (end > stat.size) yield* this.#truncate(descriptor, end);
    return 0;
  }

  *fdClose(fd: number): WasiCall<number> {
    yield* this.#descriptors.close(fd);
    return 0;
  }

  *fdDatasync(fd: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    requireRight(descriptor, RIGHTS.FD_DATASYNC);
    yield* this.#sync(descriptor, true);
    return 0;
  }

  *fdSync(fd: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    requireRight(descriptor, RIGHTS.FD_SYNC);
    yield* this.#sync(descriptor, false);
    return 0;
  }

  *fdFdstatGet(fd: number, output: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    this.#memory.range(output, 24);
    const view = this.#memory.writeView(output, 24);
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
    view.setUint8(0, filetype(descriptor.kind === "stdio" ? "character" : descriptor.kind));
    view.setUint16(2, descriptor.flags, true);
    view.setBigUint64(8, descriptor.rightsBase, true);
    view.setBigUint64(16, descriptor.rightsInheriting, true);
    return 0;
  }

  *fdFdstatSetFlags(fd: number, flags: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    requireRight(descriptor, RIGHTS.FD_FDSTAT_SET_FLAGS);
    if (!Number.isInteger(flags) || flags < 0 || (flags & ~31) !== 0) {
      throw new WasiError(EINVAL);
    }
    if (
      (flags & FDFLAGS.NONBLOCK) !== 0 &&
      (descriptor.kind !== "stdio" || descriptor.stdio?.supportsNonblocking !== true)
    )
      throw new WasiError(ENOTSUP);
    descriptor.flags = flags;
    return 0;
  }

  *fdFdstatSetRights(fd: number, base: bigint, inheriting: bigint): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    const unsignedBase = BigInt.asUintN(64, base);
    const unsignedInheriting = BigInt.asUintN(64, inheriting);
    if (
      (unsignedBase & ~descriptor.rightsBase) !== 0n ||
      (unsignedInheriting & ~descriptor.rightsInheriting) !== 0n
    ) {
      throw new WasiError(ENOTCAPABLE);
    }
    descriptor.rightsBase = unsignedBase;
    descriptor.rightsInheriting = unsignedInheriting;
    return 0;
  }

  *fdFilestatGet(fd: number, output: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    requireRight(descriptor, RIGHTS.FD_FILESTAT_GET);
    this.#memory.range(output, 64);
    let stat: Stat;
    let device = 0n;
    let inode = 0n;
    if (descriptor.kind === "stdio") {
      stat = stdioStat();
    } else {
      const storageDescriptor = requireStorageDescriptor(descriptor);
      stat = yield* this.#stat(storageDescriptor);
      device = storageDescriptor.mount.device;
      inode = storageDescriptor.inode;
    }
    writeFilestat(
      this.#memory,
      output,
      device,
      inode,
      stat,
      descriptor.kind === "stdio" ? "character" : descriptor.kind,
    );
    return 0;
  }

  *fdFilestatSetSize(fd: number, size: bigint): WasiCall<number> {
    const descriptor = this.#storageDescriptor(fd);
    requireRight(descriptor, RIGHTS.FD_FILESTAT_SET_SIZE);
    this.#requireWritable(descriptor);
    const newSize = normalizeU64(size);
    if (newSize > MAX_FILE_SIZE) throw new WasiError(EFBIG);
    const stat = yield* this.#stat(descriptor);
    if (stat.type !== "file") throw new WasiError(stat.type === "directory" ? EISDIR : EINVAL);
    yield* this.#truncate(descriptor, newSize);
    return 0;
  }

  *fdFilestatSetTimes(fd: number, atim: bigint, mtim: bigint, flags: number): WasiCall<number> {
    const descriptor = this.#storageDescriptor(fd);
    requireRight(descriptor, RIGHTS.FD_FILESTAT_SET_TIMES);
    this.#requireWritable(descriptor);
    const times = readTimes(atim, mtim, flags);
    yield* complete(descriptor.mount.storage.setTimes(descriptor.inode, times));
    return 0;
  }

  *fdPrestatGet(fd: number, output: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    if (!descriptor.preopen || descriptor.preopenPath === undefined) throw new WasiError(ENOTSUP);
    const pathLength = new TextEncoder().encode(descriptor.preopenPath).byteLength;
    this.#memory.range(output, 8);
    const view = this.#memory.writeView(output, 8);
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
    view.setUint8(0, 0);
    view.setUint32(4, pathLength, true);
    return 0;
  }

  *fdPrestatDirName(fd: number, path: number, pathLen: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    if (!descriptor.preopen || descriptor.preopenPath === undefined) throw new WasiError(ENOTSUP);
    const encoded = new TextEncoder().encode(descriptor.preopenPath);
    const capacity = pathLen >>> 0;
    if (capacity < encoded.byteLength) throw new WasiError(ENAMETOOLONG);
    this.#memory.writeRange(path, encoded.byteLength).set(encoded);
    return 0;
  }

  *fdPread(
    fd: number,
    iovs: number,
    iovsLen: number,
    offset: bigint,
    nread: number,
  ): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    const operation = (): WasiCall<number> =>
      this.#fdPread(descriptor, iovs, iovsLen, offset, nread);
    if ((descriptor.flags & FDFLAGS.RSYNC) !== 0) {
      return yield* descriptor.withOffset(operation);
    }
    return yield* operation();
  }

  *#fdPread(
    descriptor: WasiDescriptor,
    iovs: number,
    iovsLen: number,
    offset: bigint,
    nread: number,
  ): WasiCall<number> {
    requireRight(descriptor, RIGHTS.FD_READ);
    requireRight(descriptor, RIGHTS.FD_SEEK);
    this.#memory.range(nread, 4);
    const vectors = this.#memory.iovecs(iovs, iovsLen);
    const limit = vectorLimit(this.#memory, vectors);
    const position = normalizeU64(offset);
    if (descriptor.kind === "stdio") throw new WasiError(ESPIPE);
    yield* this.#syncBeforeRead(descriptor);
    const count = yield* this.#readVectors(
      requireStorageDescriptor(descriptor),
      vectors,
      limit,
      position,
    );
    this.#memory.u32(nread, count);
    return 0;
  }

  *fdPwrite(
    fd: number,
    iovs: number,
    iovsLen: number,
    offset: bigint,
    nwritten: number,
  ): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    const operation = (): WasiCall<number> =>
      this.#fdPwrite(descriptor, iovs, iovsLen, offset, nwritten);
    if ((descriptor.flags & (FDFLAGS.SYNC | FDFLAGS.DSYNC)) !== 0) {
      return yield* descriptor.withOffset(operation);
    }
    return yield* operation();
  }

  *#fdPwrite(
    descriptor: WasiDescriptor,
    iovs: number,
    iovsLen: number,
    offset: bigint,
    nwritten: number,
  ): WasiCall<number> {
    requireRight(descriptor, RIGHTS.FD_WRITE);
    requireRight(descriptor, RIGHTS.FD_SEEK);
    this.#memory.range(nwritten, 4);
    const vectors = this.#memory.iovecs(iovs, iovsLen);
    const source = this.#memory.copyIovecs(vectors, vectorLimit(this.#memory, vectors));
    const position = normalizeU64(offset);
    if (descriptor.kind === "stdio") throw new WasiError(ESPIPE);
    this.#requireWritable(descriptor);
    const count = yield* this.#writeBytes(
      requireStorageDescriptor(descriptor),
      source,
      position,
      false,
    );
    yield* this.#syncAfterWrite(descriptor);
    this.#memory.u32(nwritten, count);
    return 0;
  }

  *fdRead(fd: number, iovs: number, iovsLen: number, nread: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    const operation = () => this.#fdRead(descriptor, iovs, iovsLen, nread);
    if (descriptor.kind === "stdio" && (descriptor.flags & FDFLAGS.NONBLOCK) !== 0) {
      return yield* operation();
    }
    return yield* descriptor.withOffset(operation);
  }

  *#fdRead(
    descriptor: WasiDescriptor,
    iovs: number,
    iovsLen: number,
    nread: number,
  ): WasiCall<number> {
    requireRight(descriptor, RIGHTS.FD_READ);
    this.#memory.range(nread, 4);
    const vectors = this.#memory.iovecs(iovs, iovsLen);
    const limit = vectorLimit(this.#memory, vectors);
    yield* this.#syncBeforeRead(descriptor);
    const count =
      descriptor.kind === "stdio"
        ? yield* this.#readStdio(descriptor, vectors, limit)
        : yield* this.#readVectors(
            requireStorageDescriptor(descriptor),
            vectors,
            limit,
            descriptor.offset,
          );
    if (descriptor.kind !== "stdio") descriptor.offset += BigInt(count);
    this.#memory.u32(nread, count);
    return 0;
  }

  *fdReaddir(
    fd: number,
    buffer: number,
    bufferLen: number,
    cookie: bigint,
    bufused: number,
  ): WasiCall<number> {
    const descriptor = this.#requireDirectory(fd, RIGHTS.FD_READDIR);
    const length = bufferLen >>> 0;
    this.#memory.validateRange(buffer, length);
    const capacity = Math.min(length, this.#memory.transferLimit);
    this.#memory.range(bufused, 4);
    const entries = yield* this.#getDirectoryEntries(descriptor);
    const used = encodeDirectoryEntries(this.#memory, buffer, capacity, cookie, entries);
    this.#memory.u32(bufused, used);
    return 0;
  }

  *fdRenumber(from: number, to: number): WasiCall<number> {
    yield* this.#descriptors.renumber(from, to);
    return 0;
  }

  *fdSeek(fd: number, offset: bigint, whence: number, newOffset: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    return yield* descriptor.withOffset(() => this.#fdSeek(descriptor, offset, whence, newOffset));
  }

  *#fdSeek(
    descriptor: WasiDescriptor,
    offset: bigint,
    whence: number,
    newOffset: number,
  ): WasiCall<number> {
    requireRight(descriptor, whence === 1 && offset === 0n ? RIGHTS.FD_TELL : RIGHTS.FD_SEEK);
    this.#memory.range(newOffset, 8);
    if (descriptor.kind === "stdio") throw new WasiError(ESPIPE);
    let base: bigint;
    switch (whence) {
      case 0:
        base = 0n;
        break;
      case 1:
        base = descriptor.offset;
        break;
      case 2: {
        const storageDescriptor = requireStorageDescriptor(descriptor);
        base = (yield* this.#stat(storageDescriptor)).size;
        break;
      }
      default:
        throw new WasiError(EINVAL);
    }
    const result = base + offset;
    if (result < 0n) throw new WasiError(EINVAL);
    if (result > MAX_FILE_SIZE) throw new WasiError(EOVERFLOW);
    this.#memory.u64(newOffset, result);
    descriptor.offset = result;
    if (descriptor.kind === "directory") delete descriptor.directorySnapshot;
    return 0;
  }

  *fdTell(fd: number, offset: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    return yield* descriptor.withOffset(() => this.#fdTell(descriptor, offset));
  }

  *#fdTell(descriptor: WasiDescriptor, offset: number): WasiCall<number> {
    requireRight(descriptor, RIGHTS.FD_TELL);
    this.#memory.range(offset, 8);
    if (descriptor.kind === "stdio") throw new WasiError(ESPIPE);
    this.#memory.u64(offset, descriptor.offset);
    return 0;
  }

  *fdWrite(fd: number, iovs: number, iovsLen: number, nwritten: number): WasiCall<number> {
    const descriptor = this.#descriptors.get(fd);
    const operation = () => this.#fdWrite(descriptor, iovs, iovsLen, nwritten);
    if (descriptor.kind === "stdio" && (descriptor.flags & FDFLAGS.NONBLOCK) !== 0) {
      return yield* operation();
    }
    return yield* descriptor.withOffset(operation);
  }

  *#fdWrite(
    descriptor: WasiDescriptor,
    iovs: number,
    iovsLen: number,
    nwritten: number,
  ): WasiCall<number> {
    requireRight(descriptor, RIGHTS.FD_WRITE);
    this.#memory.range(nwritten, 4);
    const vectors = this.#memory.iovecs(iovs, iovsLen);
    const source = this.#memory.copyIovecs(vectors, vectorLimit(this.#memory, vectors));
    if (descriptor.kind !== "stdio") this.#requireWritable(descriptor);
    const count =
      descriptor.kind === "stdio"
        ? yield* this.#writeStdio(descriptor, source)
        : yield* this.#writeBytes(
            requireStorageDescriptor(descriptor),
            source,
            descriptor.offset,
            true,
          );
    if (descriptor.kind !== "stdio" && (descriptor.flags & FDFLAGS.APPEND) === 0) {
      descriptor.offset += BigInt(count);
    }
    yield* this.#syncAfterWrite(descriptor);
    this.#memory.u32(nwritten, count);
    return 0;
  }

  #storageDescriptor(fd: number): WasiStorageDescriptor {
    const descriptor = this.#descriptors.get(fd);
    return requireStorageDescriptor(descriptor);
  }

  #requireDirectory(fd: number, right: bigint): WasiStorageDescriptor {
    const descriptor = this.#descriptors.get(fd);
    requireRight(descriptor, right);
    if (descriptor.kind !== "directory") throw new WasiError(ENOTDIR);
    return requireStorageDescriptor(descriptor);
  }

  #requireWritable(descriptor: WasiDescriptor): void {
    if (descriptor.mount?.readOnly) throw new WasiError(EROFS);
  }

  *#sync(descriptor: WasiDescriptor, dataOnly: boolean): WasiCall<void> {
    if (descriptor.kind === "stdio") {
      if (descriptor.stdio?.sync !== undefined) yield* complete(descriptor.stdio.sync());
    } else {
      const storageDescriptor = requireStorageDescriptor(descriptor);
      if (storageDescriptor.byteAccess !== undefined) {
        storageDescriptor.byteAccess.sync(dataOnly);
      } else {
        yield* complete(storageDescriptor.mount.storage.sync(storageDescriptor.inode, dataOnly));
      }
    }
  }

  *#syncBeforeRead(descriptor: WasiDescriptor): WasiCall<void> {
    if ((descriptor.flags & FDFLAGS.RSYNC) !== 0) yield* this.#sync(descriptor, false);
  }

  *#syncAfterWrite(descriptor: WasiDescriptor): WasiCall<void> {
    if ((descriptor.flags & (FDFLAGS.SYNC | FDFLAGS.DSYNC)) !== 0) {
      yield* this.#sync(descriptor, (descriptor.flags & FDFLAGS.DSYNC) !== 0);
    }
  }

  *#readStdio(
    descriptor: WasiDescriptor,
    vectors: { pointer: number; length: number }[],
    limit: number,
  ): WasiCall<number> {
    if (vectors.length === 0 || limit === 0) return 0;
    const readInto = descriptor.stdio?.readInto;
    if (readInto === undefined) return 0;
    let total = 0;
    for (const vector of vectors) {
      let offset = 0;
      while (offset < vector.length && total < limit) {
        const size = Math.min(vector.length - offset, limit - total, IO_CHUNK_BYTES);
        const scratch = new Uint8Array(size);
        let count: number;
        try {
          const result = readInto.call(descriptor.stdio, scratch, descriptor.flags);
          count = yield* complete(nonblockingResult(result, descriptor.flags));
        } catch (error) {
          if (total > 0 && mapErrno(error) === 6) return total;
          throw error;
        }
        validateCount(count, size);
        if (count === 0) return total;
        this.#memory.writeRange(vector.pointer + offset, count).set(scratch.subarray(0, count));
        offset += count;
        total += count;
        if (count < size) return total;
      }
    }
    return total;
  }

  *#writeStdio(descriptor: WasiDescriptor, source: Uint8Array): WasiCall<number> {
    const write = descriptor.stdio?.write;
    if (write === undefined) throw new WasiError(EIO);
    if (source.byteLength === 0) return 0;
    const result = write.call(descriptor.stdio, source, descriptor.flags);
    const count = yield* complete(nonblockingResult(result, descriptor.flags));
    validateCount(count, source.byteLength);
    return count;
  }

  *#readVectors(
    descriptor: WasiStorageDescriptor,
    vectors: { pointer: number; length: number }[],
    limit: number,
    position: bigint,
  ): WasiCall<number> {
    const stat = yield* this.#stat(descriptor);
    if (stat.type !== "file") throw new WasiError(stat.type === "directory" ? EISDIR : EINVAL);
    let total = 0;
    for (const vector of vectors) {
      let offset = 0;
      while (offset < vector.length && total < limit) {
        const size = Math.min(vector.length - offset, limit - total, IO_CHUNK_BYTES);
        if (position + BigInt(total) + BigInt(size) > MAX_FILE_SIZE) throw new WasiError(EOVERFLOW);
        const scratch = new Uint8Array(size);
        const count = yield* this.#readInto(descriptor, position + BigInt(total), scratch);
        validateCount(count, size);
        if (count === 0) return total;
        this.#memory.writeRange(vector.pointer + offset, count).set(scratch.subarray(0, count));
        total += count;
        offset += count;
        if (count < size) return total;
      }
    }
    return total;
  }

  *#writeBytes(
    descriptor: WasiStorageDescriptor,
    source: Uint8Array,
    position: bigint,
    useAppend: boolean,
  ): WasiCall<number> {
    const stat = yield* this.#stat(descriptor);
    if (stat.type !== "file") throw new WasiError(stat.type === "directory" ? EISDIR : EINVAL);
    if (source.byteLength === 0) return 0;
    if (useAppend && (descriptor.flags & FDFLAGS.APPEND) !== 0) {
      let result: { offset: bigint; bytesWritten: number };
      if (descriptor.byteAccess === undefined) {
        result = yield* complete(descriptor.mount.storage.append(descriptor.inode, source));
      } else {
        result = descriptor.byteAccess.append(source);
      }
      validateCount(result.bytesWritten, source.byteLength);
      descriptor.offset = result.offset + BigInt(result.bytesWritten);
      return result.bytesWritten;
    }
    if (descriptor.byteAccess !== undefined) {
      if (position + BigInt(source.byteLength) > MAX_FILE_SIZE) throw new WasiError(EFBIG);
      const count = descriptor.byteAccess.write(position, source);
      validateCount(count, source.byteLength);
      if (count === 0) throw new WasiError(EIO);
      return count;
    }
    let total = 0;
    while (total < source.byteLength) {
      const size = Math.min(source.byteLength - total, IO_CHUNK_BYTES);
      const offset = position + BigInt(total);
      if (offset + BigInt(size) > MAX_FILE_SIZE) throw new WasiError(EFBIG);
      const count = yield* complete(
        descriptor.mount.storage.write(
          descriptor.inode,
          offset,
          source.subarray(total, total + size),
        ),
      );
      validateCount(count, size);
      if (count === 0) throw new WasiError(EIO);
      total += count;
      if (count < size) return total;
    }
    return total;
  }

  *#stat(descriptor: WasiStorageDescriptor): WasiCall<Stat> {
    if (descriptor.byteAccess !== undefined) return descriptor.byteAccess.stat();
    return yield* complete(descriptor.mount.storage.stat(descriptor.inode));
  }

  *#readInto(
    descriptor: WasiStorageDescriptor,
    offset: bigint,
    target: Uint8Array,
  ): WasiCall<number> {
    if (descriptor.byteAccess !== undefined) {
      return descriptor.byteAccess.readInto(offset, target);
    }
    return yield* complete(descriptor.mount.storage.readInto(descriptor.inode, offset, target));
  }

  *#truncate(descriptor: WasiStorageDescriptor, size: bigint): WasiCall<void> {
    if (descriptor.byteAccess !== undefined) {
      descriptor.byteAccess.truncate(size);
      return;
    }
    yield* complete(descriptor.mount.storage.truncate(descriptor.inode, size));
  }

  *#getDirectoryEntries(descriptor: WasiStorageDescriptor): WasiCall<DirectoryEntry[]> {
    if (descriptor.directorySnapshot !== undefined) return descriptor.directorySnapshot;
    const children = yield* complete(descriptor.mount.storage.readdir(descriptor.inode));
    const parent =
      descriptor.ancestors !== undefined && descriptor.ancestors.length > 1
        ? descriptor.ancestors[descriptor.ancestors.length - 2]
        : descriptor.capabilityRoot;
    if (parent === undefined) throw new WasiError(EBADF);
    const entries: DirectoryEntry[] = [
      { name: ".", inode: descriptor.inode, type: "directory" },
      { name: "..", inode: parent, type: "directory" },
      ...children,
    ];
    descriptor.directorySnapshot = entries;
    return entries;
  }
}

function requireRight(descriptor: WasiDescriptor, right: bigint): void {
  if ((descriptor.rightsBase & right) !== right) throw new WasiError(ENOTCAPABLE);
}

function requireStorageDescriptor(descriptor: WasiDescriptor): WasiStorageDescriptor {
  if (
    descriptor.kind === "stdio" ||
    descriptor.mount === undefined ||
    descriptor.inode === undefined
  ) {
    throw new WasiError(EBADF);
  }
  return descriptor as WasiStorageDescriptor;
}

function validateCount(count: number, maximum: number): void {
  if (!Number.isInteger(count) || count < 0 || count > maximum) throw new WasiError(EIO);
}

// signalbox: a short transfer obeys the owner-issued credit without rewriting the guest table.
function vectorLimit(memory: WasiMemory, vectors: { length: number }[]): number {
  let total = 0;
  for (const vector of vectors) {
    total += vector.length;
    // A bounded partial transfer keeps copied write data within the host's
    // memory budget. The guest can retry the untransferred suffix.
    if (total >= memory.transferLimit) return memory.transferLimit;
  }
  return total;
}

function normalizeU64(value: bigint): bigint {
  const normalized = BigInt.asUintN(64, value);
  if (normalized !== value) throw new WasiError(EOVERFLOW);
  return normalized;
}

export function filetype(type: "file" | "directory" | "symlink" | "character"): number {
  switch (type) {
    case "character":
      return 2;
    case "directory":
      return 3;
    case "file":
      return 4;
    case "symlink":
      return 7;
  }
}

export function writeFilestat(
  memory: WasiMemory,
  pointer: number,
  device: bigint,
  inode: Inode,
  stat: Stat,
  type: "file" | "directory" | "symlink" | "character" = stat.type,
): void {
  const view = memory.writeView(pointer, 64);
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
  view.setBigUint64(0, BigInt.asUintN(64, device), true);
  view.setBigUint64(8, BigInt.asUintN(64, inode), true);
  view.setUint8(16, filetype(type));
  view.setBigUint64(24, BigInt.asUintN(64, stat.nlink), true);
  view.setBigUint64(32, BigInt.asUintN(64, stat.size), true);
  view.setBigUint64(40, BigInt.asUintN(64, stat.atimeNs), true);
  view.setBigUint64(48, BigInt.asUintN(64, stat.mtimeNs), true);
  view.setBigUint64(56, BigInt.asUintN(64, stat.ctimeNs), true);
}

function stdioStat(): Stat {
  return {
    type: "file",
    size: 0n,
    nlink: 1n,
    atimeNs: 0n,
    mtimeNs: 0n,
    ctimeNs: 0n,
  };
}

export function readTimes(atim: bigint, mtim: bigint, flags: number): Times {
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~15) !== 0) throw new WasiError(EINVAL);
  const atimeNow = (flags & 2) !== 0;
  const mtimeNow = (flags & 8) !== 0;
  if (((flags & 1) !== 0 && atimeNow) || ((flags & 4) !== 0 && mtimeNow)) {
    throw new WasiError(EINVAL);
  }
  const now = BigInt(Date.now()) * 1_000_000n;
  const times: Times = {};
  if ((flags & 1) !== 0) times.atimeNs = normalizeTime(atim);
  if (atimeNow) times.atimeNs = now;
  if ((flags & 4) !== 0) times.mtimeNs = normalizeTime(mtim);
  if (mtimeNow) times.mtimeNs = now;
  return times;
}

function normalizeTime(value: bigint): bigint {
  const time = BigInt.asUintN(64, value);
  if (time !== value || time > MAX_FILE_SIZE) throw new WasiError(EOVERFLOW);
  return time;
}

function encodeDirectoryEntries(
  memory: WasiMemory,
  pointer: number,
  capacity: number,
  cookie: bigint,
  entries: DirectoryEntry[],
): number {
  const start = BigInt.asUintN(64, cookie);
  if (start > DIR_COOKIE_MAX) return 0;
  let index = Number(start);
  let offset = 0;
  memory.range(pointer, capacity);
  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined) throw new TypeError("Invalid directory entry");
    const name = new TextEncoder().encode(entry.name);
    const recordLength = 24 + name.byteLength;
    const record = new Uint8Array(recordLength);
    const view = new DataView(record.buffer);
    view.setBigUint64(0, BigInt(index + 1), true);
    view.setBigUint64(8, BigInt.asUintN(64, entry.inode), true);
    view.setUint32(16, name.byteLength, true);
    view.setUint8(20, filetype(entry.type));
    record.set(name, 24);
    const used = Math.min(recordLength, capacity - offset);
    memory.writeRange(pointer + offset, used).set(record.subarray(0, used));
    offset += used;
    if (used < recordLength) break;
    index++;
  }
  return offset;
}

function nonblockingResult(result: number | Promise<number>, flags: number) {
  if ((flags & FDFLAGS.NONBLOCK) !== 0 && typeof result !== "number") {
    void Promise.resolve(result).catch(() => undefined);
    throw new WasiError(ENOTSUP);
  }
  return result;
}
