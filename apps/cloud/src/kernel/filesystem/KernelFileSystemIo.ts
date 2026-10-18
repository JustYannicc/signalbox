import {
  FDFLAGS,
  RIGHTS,
  WasiDescriptorTable,
  type WasiDescriptor,
} from "../wasi/internal_wasi_descriptors.ts";
import { complete, runSync, type WasiCall } from "../wasi/internal_wasi_calls.ts";
import type { Inode } from "../storage.ts";
import { kernelError, runKernelSync, withKernelErrors } from "./KernelFileSystemErrors.ts";

const MAX_FILE_SIZE = (1n << 63n) - 1n;

type StorageDescriptor = WasiDescriptor & {
  readonly kind: "file" | "directory" | "symlink";
  readonly mount: NonNullable<WasiDescriptor["mount"]>;
  readonly inode: Inode;
};

export class KernelFileSystemIo {
  readonly #descriptors: WasiDescriptorTable;

  constructor(descriptors: WasiDescriptorTable) {
    this.#descriptors = descriptors;
  }

  read(fd: number, target: Uint8Array, position: bigint | null): number {
    return withKernelErrors(() => {
      const descriptor = this.#descriptors.get(fd);
      return this.#run(descriptor.withOffset(() => this.#read(descriptor, target, position)));
    });
  }

  write(fd: number, source: Uint8Array, position: bigint | null): number {
    return withKernelErrors(() => {
      const descriptor = this.#descriptors.get(fd);
      return this.#run(descriptor.withOffset(() => this.#write(descriptor, source, position)));
    });
  }

  ftruncate(fd: number, size: bigint): void {
    withKernelErrors(() => {
      const descriptor = this.#descriptors.get(fd);
      this.#requireRight(descriptor, RIGHTS.FD_FILESTAT_SET_SIZE);
      const storage = this.#storageDescriptor(descriptor);
      this.#assertWritable(storage);
      const stat = runKernelSync(storage.mount.storage.stat(storage.inode));
      if (stat.type === "directory") throw kernelError("EISDIR");
      if (stat.type !== "file") throw kernelError("EINVAL");
      runKernelSync(storage.mount.storage.truncate(storage.inode, this.#size(size)));
    });
  }

  sync(fd: number, dataOnly = false): void {
    withKernelErrors(() => {
      const descriptor = this.#descriptors.get(fd);
      this.#requireRight(descriptor, dataOnly ? RIGHTS.FD_DATASYNC : RIGHTS.FD_SYNC);
      this.#run(descriptor.withOffset(() => this.#sync(descriptor, dataOnly)));
    });
  }

  *#read(
    descriptor: WasiDescriptor,
    target: Uint8Array,
    position: bigint | null,
  ): WasiCall<number> {
    this.#requireRight(descriptor, RIGHTS.FD_READ);
    if (position !== null && descriptor.kind === "stdio") throw kernelError("ESPIPE");
    if (position !== null) this.#offset(position);
    if (descriptor.kind === "stdio") {
      const stream = descriptor.stdio;
      if (stream?.readInto === undefined || target.byteLength === 0) return 0;
      const count = yield* complete(stream.readInto(target));
      this.#count(count, target.byteLength);
      return count;
    }
    const storage = this.#storageDescriptor(descriptor);
    yield* this.#syncBeforeRead(descriptor);
    const stat = yield* complete(storage.mount.storage.stat(storage.inode));
    if (stat.type === "directory") throw kernelError("EISDIR");
    if (stat.type !== "file") throw kernelError("EINVAL");
    const offset = position ?? descriptor.offset;
    const count = yield* complete(storage.mount.storage.readInto(storage.inode, offset, target));
    this.#count(count, target.byteLength);
    if (position === null) descriptor.offset += BigInt(count);
    return count;
  }

  *#write(
    descriptor: WasiDescriptor,
    source: Uint8Array,
    position: bigint | null,
  ): WasiCall<number> {
    this.#requireRight(descriptor, RIGHTS.FD_WRITE);
    if (position !== null && descriptor.kind === "stdio") throw kernelError("ESPIPE");
    if (position !== null) this.#offset(position);
    if (descriptor.kind === "stdio") {
      const stream = descriptor.stdio;
      if (stream?.write === undefined) throw kernelError("EIO");
      if (source.byteLength === 0) return 0;
      const count = yield* complete(stream.write(source));
      this.#count(count, source.byteLength);
      yield* this.#syncAfterWrite(descriptor);
      return count;
    }
    const storage = this.#storageDescriptor(descriptor);
    this.#assertWritable(storage);
    const stat = yield* complete(storage.mount.storage.stat(storage.inode));
    if (stat.type === "directory") throw kernelError("EISDIR");
    if (stat.type !== "file") throw kernelError("EINVAL");
    if (source.byteLength === 0) return 0;

    let count: number;
    if (position === null && (descriptor.flags & FDFLAGS.APPEND) !== 0) {
      const appended = yield* complete(storage.mount.storage.append(storage.inode, source));
      this.#count(appended.bytesWritten, source.byteLength);
      descriptor.offset = appended.offset + BigInt(appended.bytesWritten);
      count = appended.bytesWritten;
    } else {
      const offset = position ?? descriptor.offset;
      if (offset + BigInt(source.byteLength) > MAX_FILE_SIZE) throw kernelError("EFBIG");
      count = yield* complete(storage.mount.storage.write(storage.inode, offset, source));
      this.#count(count, source.byteLength);
      if (count === 0) throw kernelError("EIO");
      if (position === null) descriptor.offset += BigInt(count);
    }
    yield* this.#syncAfterWrite(descriptor);
    return count;
  }

  *#syncBeforeRead(descriptor: WasiDescriptor): WasiCall<void> {
    if ((descriptor.flags & FDFLAGS.RSYNC) !== 0) yield* this.#sync(descriptor, false);
  }

  *#syncAfterWrite(descriptor: WasiDescriptor): WasiCall<void> {
    if ((descriptor.flags & (FDFLAGS.SYNC | FDFLAGS.DSYNC)) !== 0) {
      yield* this.#sync(descriptor, (descriptor.flags & FDFLAGS.DSYNC) !== 0);
    }
  }

  *#sync(descriptor: WasiDescriptor, dataOnly: boolean): WasiCall<void> {
    if (descriptor.kind === "stdio") {
      const stream = descriptor.stdio;
      if (stream?.sync !== undefined) yield* complete(stream.sync());
      return;
    }
    const storage = this.#storageDescriptor(descriptor);
    yield* complete(storage.mount.storage.sync(storage.inode, dataOnly));
  }

  #storageDescriptor(descriptor: WasiDescriptor): StorageDescriptor {
    if (
      descriptor.kind === "stdio" ||
      descriptor.mount === undefined ||
      descriptor.inode === undefined
    ) {
      throw kernelError("EBADF");
    }
    return descriptor as StorageDescriptor;
  }

  #assertWritable(descriptor: StorageDescriptor): void {
    if (descriptor.mount.readOnly) throw kernelError("EROFS");
  }

  #requireRight(descriptor: WasiDescriptor, right: bigint): void {
    if ((descriptor.rightsBase & right) !== right) throw kernelError("EBADF");
  }

  #offset(value: bigint): void {
    if (value < 0n) throw kernelError("EINVAL");
    if (value > MAX_FILE_SIZE) throw kernelError("EFBIG");
  }

  #size(value: bigint): bigint {
    this.#offset(value);
    return value;
  }

  #count(count: number, maximum: number): void {
    if (!Number.isInteger(count) || count < 0 || count > maximum) throw kernelError("EIO");
  }

  #run<T>(call: WasiCall<T>): T {
    return withKernelErrors(() => runSync(call));
  }
}
