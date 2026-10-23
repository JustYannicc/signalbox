// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Inode, Stat } from "../storage.ts";
import type { KernelFileByteAccess, KernelFileByteView } from "../KernelFileBytes.ts";
import { WasiError } from "./internal_wasi_memory.ts";
import type { WasiCall } from "./internal_wasi_calls.ts";
import type { WasiMountedStorage } from "./internal_wasi_paths.ts";
import { WasiOpenDescription } from "./internal_wasi_open_description.ts";
import type { WasiStdio } from "./internal_wasi_stdio.ts";

export type { WasiPollResult, WasiStdio } from "./internal_wasi_stdio.ts";

const EEXIST = 20;
const EBADF = 8;
const EBUSY = 10;
const EMFILE = 33;
const ENOTCAPABLE = 76;
const MAX_DESCRIPTORS = 1_048_576;
const MAX_UINT32 = 0xffff_ffff;
const MAX_ALLOCATED_FD = 0x7fff_ffff;

export const RIGHTS = {
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  PATH_SYMLINK: 1n << 24n,
  PATH_REMOVE_DIRECTORY: 1n << 25n,
  PATH_UNLINK_FILE: 1n << 26n,
  POLL_FD_READWRITE: 1n << 27n,
} as const;

export const ALL_RIGHTS = Object.values(RIGHTS).reduce((all, right) => all | right, 0n);
const MUTATING_RIGHTS =
  RIGHTS.FD_DATASYNC |
  RIGHTS.FD_WRITE |
  RIGHTS.FD_ALLOCATE |
  RIGHTS.PATH_CREATE_DIRECTORY |
  RIGHTS.PATH_CREATE_FILE |
  RIGHTS.PATH_LINK_TARGET |
  RIGHTS.PATH_RENAME_SOURCE |
  RIGHTS.PATH_RENAME_TARGET |
  RIGHTS.PATH_FILESTAT_SET_SIZE |
  RIGHTS.PATH_FILESTAT_SET_TIMES |
  RIGHTS.FD_FILESTAT_SET_SIZE |
  RIGHTS.FD_FILESTAT_SET_TIMES |
  RIGHTS.PATH_SYMLINK |
  RIGHTS.PATH_REMOVE_DIRECTORY |
  RIGHTS.PATH_UNLINK_FILE;
export const READ_ONLY_RIGHTS = ALL_RIGHTS & ~MUTATING_RIGHTS;

export const FDFLAGS = {
  APPEND: 1,
  DSYNC: 2,
  NONBLOCK: 4,
  RSYNC: 8,
  SYNC: 16,
} as const;

export interface WasiDescriptorSpec {
  readonly kind: "file" | "directory" | "symlink" | "stdio";
  readonly mount?: WasiMountedStorage | undefined;
  readonly inode?: Inode | undefined;
  readonly capabilityRoot?: Inode | undefined;
  readonly ancestors?: Inode[] | undefined;
  readonly pathComponents?: string[] | undefined;
  readonly preopenPath?: string | undefined;
  readonly preopen?: boolean | undefined;
  readonly stdio?: WasiStdio | undefined;
  readonly stdioIndex?: 0 | 1 | 2 | undefined;
  readonly byteAccess?: KernelFileByteAccess | undefined;
  readonly byteView?: KernelFileByteView | undefined;
  offset: bigint;
  rightsBase: bigint;
  rightsInheriting: bigint;
  flags: number;
  closeOnExec?: boolean;
  directorySnapshot?: { name: string; inode: Inode; type: Stat["type"] }[] | undefined;
  /** Internal endpoint cleanup, called once when the last alias closes. */
  onLastClose?: () => void | Promise<void>;
}

export interface WasiDescriptor {
  fd: number;
  readonly kind: WasiDescriptorSpec["kind"];
  readonly mount?: WasiMountedStorage | undefined;
  readonly inode?: Inode | undefined;
  readonly capabilityRoot?: Inode | undefined;
  readonly ancestors?: Inode[] | undefined;
  readonly pathComponents?: string[] | undefined;
  readonly preopenPath?: string | undefined;
  readonly preopen?: boolean | undefined;
  readonly stdio?: WasiStdio | undefined;
  readonly stdioIndex?: 0 | 1 | 2 | undefined;
  readonly byteAccess?: KernelFileByteAccess | undefined;
  readonly byteView?: KernelFileByteView | undefined;
  offset: bigint;
  rightsBase: bigint;
  rightsInheriting: bigint;
  flags: number;
  closeOnExec: boolean;
  directorySnapshot?: { name: string; inode: Inode; type: Stat["type"] }[] | undefined;
  withOffset<T>(operation: () => WasiCall<T>, owner?: object): WasiCall<T>;
  withWrite<T>(operation: () => WasiCall<T>, owner?: object): WasiCall<T>;
  acquireIo(owner: object, write: boolean, signal?: AbortSignal): WasiCall<() => void>;
}

export interface WasiDescriptorDupOptions {
  readonly rightsBase?: bigint;
  readonly rightsInheriting?: bigint;
  readonly closeOnExec?: boolean;
}

export interface WasiDescriptorMapEntry {
  readonly parentFd: number;
  readonly childFd: number;
}

export type WasiDescriptorMapping = readonly WasiDescriptorMapEntry[] | ReadonlyMap<number, number>;

export interface WasiForkOptions {
  /** Excludes mapped close-on-exec descriptors when the child immediately execs. */
  readonly exec?: boolean;
}

/** A descriptor handle whose offset and status flags proxy a shared open file. */
class WasiDescriptorHandle implements WasiDescriptor {
  #fd: number;
  readonly #description: WasiOpenDescription;
  readonly #capabilityRoot: Inode | undefined;
  readonly #ancestors: Inode[] | undefined;
  readonly #pathComponents: string[] | undefined;
  readonly #preopenPath: string | undefined;
  readonly #preopen: boolean | undefined;
  #rightsBase: bigint;
  #rightsInheriting: bigint;
  #closeOnExec: boolean;
  #attached: boolean;

  constructor(
    fd: number,
    spec: WasiDescriptorSpec,
    description: WasiOpenDescription,
    attached: boolean,
  ) {
    this.#fd = fd;
    this.#description = description;
    this.#capabilityRoot = spec.capabilityRoot;
    this.#ancestors = spec.ancestors;
    this.#pathComponents = spec.pathComponents;
    this.#preopenPath = spec.preopenPath;
    this.#preopen = spec.preopen;
    this.#rightsBase = normalizeDescriptorRights(spec.rightsBase);
    this.#rightsInheriting = normalizeDescriptorRights(spec.rightsInheriting);
    this.#closeOnExec = spec.closeOnExec ?? false;
    this.#attached = attached;
  }

  get fd(): number {
    return this.#fd;
  }

  set fd(value: number) {
    this.#fd = value;
  }

  get kind(): WasiDescriptorSpec["kind"] {
    return this.#description.kind;
  }

  get mount(): WasiMountedStorage | undefined {
    return this.#description.mount;
  }

  get inode(): Inode | undefined {
    return this.#description.inode;
  }

  get stdio(): WasiStdio | undefined {
    return this.#description.stdio;
  }

  get stdioIndex(): 0 | 1 | 2 | undefined {
    return this.#description.stdioIndex;
  }

  get byteAccess(): KernelFileByteAccess | undefined {
    return this.#description.byteAccess;
  }

  get byteView(): KernelFileByteView | undefined {
    return this.#description.byteView;
  }

  get capabilityRoot(): Inode | undefined {
    return this.#capabilityRoot;
  }

  get ancestors(): Inode[] | undefined {
    return this.#ancestors;
  }

  get pathComponents(): string[] | undefined {
    return this.#pathComponents;
  }

  get preopenPath(): string | undefined {
    return this.#preopenPath;
  }

  get preopen(): boolean | undefined {
    return this.#preopen;
  }

  get offset(): bigint {
    return this.#description.offset;
  }

  set offset(value: bigint) {
    this.#description.offset = value;
  }

  get rightsBase(): bigint {
    return this.#rightsBase;
  }

  set rightsBase(value: bigint) {
    this.#rightsBase = normalizeDescriptorRights(value);
  }

  get rightsInheriting(): bigint {
    return this.#rightsInheriting;
  }

  set rightsInheriting(value: bigint) {
    this.#rightsInheriting = normalizeDescriptorRights(value);
  }

  get flags(): number {
    return this.#description.flags;
  }

  set flags(value: number) {
    this.#description.flags = value;
  }

  get closeOnExec(): boolean {
    return this.#closeOnExec;
  }

  set closeOnExec(value: boolean) {
    this.#closeOnExec = value;
  }

  get directorySnapshot(): { name: string; inode: Inode; type: Stat["type"] }[] | undefined {
    return this.#description.directorySnapshot;
  }

  set directorySnapshot(value: { name: string; inode: Inode; type: Stat["type"] }[] | undefined) {
    this.#description.directorySnapshot = value;
  }

  *withOffset<T>(operation: () => WasiCall<T>, owner?: object): WasiCall<T> {
    return yield* this.#description.withOffset(operation, owner);
  }

  // signalbox: regular-file writes share an inode lock across separate open descriptions.
  *withWrite<T>(operation: () => WasiCall<T>, owner?: object): WasiCall<T> {
    return yield* this.#description.withWrite(operation, owner);
  }

  *acquireIo(owner: object, write: boolean, signal?: AbortSignal): WasiCall<() => void> {
    return yield* this.#description.acquireIo(owner, write, signal);
  }

  get description(): WasiOpenDescription {
    return this.#description;
  }

  get attached(): boolean {
    return this.#attached;
  }

  attach(fd: number): void {
    if (this.#attached) throw new WasiError(EEXIST);
    this.#fd = fd;
    this.#attached = true;
  }

  detach(): void {
    if (!this.#attached) throw new WasiError(EBADF);
    this.#attached = false;
  }

  clone(
    fd: number,
    options: WasiDescriptorDupOptions = {},
    closeOnExec = options.closeOnExec ?? false,
  ): WasiDescriptorHandle {
    const spec: WasiDescriptorSpec = {
      kind: this.kind,
      offset: this.offset,
      rightsBase: options.rightsBase ?? this.rightsBase,
      rightsInheriting: options.rightsInheriting ?? this.rightsInheriting,
      flags: this.flags,
      closeOnExec,
      ...(this.mount === undefined ? {} : { mount: this.mount }),
      ...(this.inode === undefined ? {} : { inode: this.inode }),
      ...(this.capabilityRoot === undefined ? {} : { capabilityRoot: this.capabilityRoot }),
      ...(this.ancestors === undefined ? {} : { ancestors: [...this.ancestors] }),
      ...(this.pathComponents === undefined ? {} : { pathComponents: [...this.pathComponents] }),
      ...(this.preopenPath === undefined ? {} : { preopenPath: this.preopenPath }),
      ...(this.preopen === undefined ? {} : { preopen: this.preopen }),
      ...(this.stdio === undefined ? {} : { stdio: this.stdio }),
      ...(this.stdioIndex === undefined ? {} : { stdioIndex: this.stdioIndex }),
      ...(this.directorySnapshot === undefined
        ? {}
        : { directorySnapshot: this.directorySnapshot }),
    };
    return new WasiDescriptorHandle(fd, spec, this.#description, false);
  }
}

/** Descriptor ownership, aliasing, and allocation shared by syscall adapters. */
export class WasiDescriptorTable {
  #descriptors = new Map<number, WasiDescriptorHandle>();
  #reservedFds = new Set<number>();
  #nextFd = 3;

  constructor(stdio: WasiStdio[] = []) {
    if (stdio.length !== 0 && stdio.length !== 3) throw new WasiError(28);
    for (const [fd, stream] of stdio.entries()) {
      const ioRight = fd === 0 ? RIGHTS.FD_READ : RIGHTS.FD_WRITE;
      const rightsBase =
        ioRight |
        RIGHTS.FD_FDSTAT_SET_FLAGS |
        RIGHTS.FD_SYNC |
        RIGHTS.FD_DATASYNC |
        RIGHTS.POLL_FD_READWRITE |
        RIGHTS.FD_FILESTAT_GET;
      const spec: WasiDescriptorSpec = {
        kind: "stdio",
        stdio: stream,
        stdioIndex: fd as 0 | 1 | 2,
        offset: 0n,
        rightsBase,
        rightsInheriting: 0n,
        flags: 0,
      };
      const description = new WasiOpenDescription(spec);
      this.#descriptors.set(fd, new WasiDescriptorHandle(fd, spec, description, true));
    }
  }

  get(fd: number): WasiDescriptor {
    const normalized = normalizeFd(fd);
    if (this.#reservedFds.has(normalized)) throw new WasiError(EBADF);
    const descriptor = this.#descriptors.get(normalized);
    if (descriptor === undefined) throw new WasiError(EBADF);
    return descriptor;
  }

  has(fd: number): boolean {
    return this.#descriptors.has(normalizeFd(fd));
  }

  entries(): IterableIterator<[number, WasiDescriptor]> {
    return this.#descriptors.entries();
  }

  allocate(spec: WasiDescriptorSpec): number {
    if (this.#descriptors.size >= MAX_DESCRIPTORS) throw new WasiError(EMFILE);
    const fd = this.#findAvailableFd();
    const description = new WasiOpenDescription(spec);
    const descriptor = new WasiDescriptorHandle(fd, spec, description, true);
    this.#descriptors.set(fd, descriptor);
    this.#advanceNextFd(fd);
    return fd;
  }

  /** Removes a handle without releasing its open-description reference. */
  take(fd: number): WasiDescriptor {
    const normalized = normalizeFd(fd);
    if (this.#reservedFds.has(normalized)) throw new WasiError(EBUSY);
    const descriptor = this.#descriptors.get(normalized);
    if (descriptor === undefined) throw new WasiError(EBADF);
    this.#descriptors.delete(normalized);
    descriptor.detach();
    return descriptor;
  }

  /** Attaches a handle removed with take(); ownership moves without refcounting. */
  put(fd: number, descriptor: WasiDescriptor): void {
    const normalized = normalizeFd(fd);
    if (this.#reservedFds.has(normalized)) throw new WasiError(EBUSY);
    if (this.#descriptors.has(normalized)) throw new WasiError(EEXIST);
    if (this.#descriptors.size >= MAX_DESCRIPTORS) throw new WasiError(EMFILE);
    if (!(descriptor instanceof WasiDescriptorHandle)) throw new WasiError(EBADF);
    descriptor.attach(normalized);
    this.#descriptors.set(normalized, descriptor);
  }

  /** Removes one handle and releases the inode pin after its last alias closes. */
  *close(fd: number): WasiCall<void> {
    const descriptor = this.take(fd) as WasiDescriptorHandle;
    yield* descriptor.description.release();
  }

  /** Drains every handle and reports all final backend release failures. */
  *closeAll(): WasiCall<void> {
    const errors: unknown[] = [];
    for (const fd of [...this.#descriptors.keys()]) {
      let descriptor: WasiDescriptorHandle;
      try {
        descriptor = this.take(fd) as WasiDescriptorHandle;
      } catch (error) {
        errors.push(error);
        continue;
      }
      try {
        yield* descriptor.description.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close WASI descriptors");
    }
  }

  /** Closes descriptors marked close-on-exec after spawn file actions finish. */
  *closeOnExecSweep(): WasiCall<void> {
    const errors: unknown[] = [];
    const fds = [...this.#descriptors]
      .filter(([, descriptor]) => descriptor.closeOnExec)
      .map(([fd]) => fd);
    for (const fd of fds) {
      try {
        yield* this.close(fd);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close close-on-exec WASI descriptors");
    }
  }

  /** Creates a new fd referring to the source open description. */
  duplicate(sourceFd: number, options: WasiDescriptorDupOptions = {}): number {
    const source = this.get(sourceFd) as WasiDescriptorHandle;
    const rights = validatedRights(source, options);
    if (this.#descriptors.size >= MAX_DESCRIPTORS) throw new WasiError(EMFILE);
    const fd = this.#findAvailableFd();
    const alias = source.clone(fd, rights, options.closeOnExec ?? false);
    source.description.retain();
    try {
      alias.attach(fd);
      this.#descriptors.set(fd, alias);
      this.#advanceNextFd(fd);
      return fd;
    } catch (error) {
      source.description.rollbackRetain();
      throw error;
    }
  }

  /** Replaces targetFd with an alias of sourceFd, like dup2(). */
  *duplicateTo(
    sourceFd: number,
    targetFd: number,
    options: WasiDescriptorDupOptions = {},
  ): WasiCall<number> {
    const sourceNumber = normalizeFd(sourceFd);
    const targetNumber = normalizeFd(targetFd);
    const source = this.get(sourceNumber) as WasiDescriptorHandle;
    if (sourceNumber === targetNumber) return targetNumber;
    if (this.#reservedFds.has(targetNumber)) throw new WasiError(EBUSY);
    if (!this.#descriptors.has(targetNumber) && this.#descriptors.size >= MAX_DESCRIPTORS) {
      throw new WasiError(EMFILE);
    }
    const rights = validatedRights(source, options);
    const alias = source.clone(targetNumber, rights, options.closeOnExec ?? false);
    source.description.retain();
    let reserved = false;
    try {
      this.#reservedFds.add(targetNumber);
      reserved = true;
      const target = this.#descriptors.get(targetNumber);
      if (target !== undefined) {
        this.#descriptors.delete(targetNumber);
        target.detach();
        yield* target.description.release();
      }
      alias.attach(targetNumber);
      this.#descriptors.set(targetNumber, alias);
      return targetNumber;
    } catch (error) {
      try {
        yield* alias.description.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "WASI dup2 and cleanup failed");
      }
      throw error;
    } finally {
      if (reserved) this.#reservedFds.delete(targetNumber);
    }
  }

  /** Moves sourceFd to targetFd without changing the open-description count. */
  *renumber(sourceFd: number, targetFd: number): WasiCall<void> {
    const sourceNumber = normalizeFd(sourceFd);
    const targetNumber = normalizeFd(targetFd);
    const source = this.get(sourceNumber) as WasiDescriptorHandle;
    if (sourceNumber === targetNumber) return;
    if (this.#reservedFds.has(targetNumber)) throw new WasiError(EBUSY);
    let sourceReserved = false;
    let targetReserved = false;
    try {
      this.#reservedFds.add(sourceNumber);
      sourceReserved = true;
      this.#reservedFds.add(targetNumber);
      targetReserved = true;
      const target = this.#descriptors.get(targetNumber);
      if (target !== undefined) {
        this.#descriptors.delete(targetNumber);
        target.detach();
        yield* target.description.release();
      }
      this.#descriptors.delete(sourceNumber);
      source.detach();
      source.attach(targetNumber);
      this.#descriptors.set(targetNumber, source);
    } finally {
      if (sourceReserved) this.#reservedFds.delete(sourceNumber);
      if (targetReserved) this.#reservedFds.delete(targetNumber);
    }
  }

  /**
   * Builds a child table from a parent-fd to child-fd mapping. Pass exec:false
   * when file actions must run before closeOnExecSweep().
   */
  fork(mapping: WasiDescriptorMapping, options: WasiForkOptions = {}): WasiDescriptorTable {
    const entries = mappingEntries(mapping);
    if (entries.length > MAX_DESCRIPTORS) throw new WasiError(EMFILE);

    const childFds = new Set<number>();
    const planned: { source: WasiDescriptorHandle; childFd: number }[] = [];
    for (const entry of entries) {
      const parentFd = normalizeFd(entry.parentFd);
      const childFd = normalizeFd(entry.childFd);
      if (childFds.has(childFd)) throw new WasiError(EEXIST);
      childFds.add(childFd);
      planned.push({
        source: this.get(parentFd) as WasiDescriptorHandle,
        childFd,
      });
    }

    const inherited = planned.filter(({ source }) => !(options.exec && source.closeOnExec));
    if (inherited.length > MAX_DESCRIPTORS) throw new WasiError(EMFILE);

    const child = new WasiDescriptorTable();
    const aliases = inherited.map(({ source, childFd }) =>
      source.clone(childFd, {}, source.closeOnExec),
    );
    let retained = 0;
    try {
      for (const alias of aliases) {
        alias.description.retain();
        retained++;
      }
      for (const alias of aliases) {
        alias.attach(alias.fd);
        child.#descriptors.set(alias.fd, alias);
      }
      return child;
    } catch (error) {
      child.#descriptors.clear();
      for (const alias of aliases) {
        if (alias.attached) alias.detach();
      }
      for (const alias of aliases.slice(0, retained).reverse()) {
        alias.description.rollbackRetain();
      }
      throw error;
    }
  }

  #findAvailableFd(): number {
    let fd = this.#nextFd;
    const start = fd;
    while (this.#descriptors.has(fd) || this.#reservedFds.has(fd)) {
      fd++;
      if (fd > MAX_ALLOCATED_FD) fd = 3;
      if (fd === start) throw new WasiError(EMFILE);
    }
    return fd;
  }

  #advanceNextFd(fd: number): void {
    this.#nextFd = fd + 1;
    if (this.#nextFd > MAX_ALLOCATED_FD) this.#nextFd = 3;
  }
}

function normalizeFd(fd: number): number {
  if (!Number.isInteger(fd) || fd < 0 || fd > MAX_UINT32) throw new WasiError(EBADF);
  return fd;
}

function normalizeDescriptorRights(rights: bigint): bigint {
  const normalized = BigInt.asUintN(64, rights);
  return (normalized & RIGHTS.FD_SEEK) !== 0n ? normalized | RIGHTS.FD_TELL : normalized;
}

function validatedRights(
  source: WasiDescriptor,
  options: WasiDescriptorDupOptions,
): WasiDescriptorDupOptions {
  const rightsBase = options.rightsBase ?? source.rightsBase;
  const rightsInheriting = options.rightsInheriting ?? source.rightsInheriting;
  if (
    (BigInt.asUintN(64, rightsBase) & ~source.rightsBase) !== 0n ||
    (BigInt.asUintN(64, rightsInheriting) & ~source.rightsInheriting) !== 0n
  ) {
    throw new WasiError(ENOTCAPABLE);
  }
  return {
    rightsBase: BigInt.asUintN(64, rightsBase),
    rightsInheriting: BigInt.asUintN(64, rightsInheriting),
  };
}

function mappingEntries(mapping: WasiDescriptorMapping): WasiDescriptorMapEntry[] {
  if (Array.isArray(mapping)) {
    return (mapping as readonly WasiDescriptorMapEntry[]).map(({ parentFd, childFd }) => ({
      parentFd,
      childFd,
    }));
  }
  return [...(mapping as ReadonlyMap<number, number>).entries()].map(([parentFd, childFd]) => ({
    parentFd,
    childFd,
  }));
}
