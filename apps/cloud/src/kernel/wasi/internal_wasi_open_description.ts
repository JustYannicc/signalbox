// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Inode, DirectoryEntry } from "../storage.ts";
import { KernelIoLock, acquireKernelFileWrite } from "../KernelIoLock.ts";
import type { KernelFileByteAccess, KernelFileByteView } from "../KernelFileBytes.ts";
import { complete, type WasiCall } from "./internal_wasi_calls.ts";
import { WasiError } from "./internal_wasi_memory.ts";
import type { WasiStdio } from "./internal_wasi_stdio.ts";
import type { WasiMountedStorage } from "./internal_wasi_paths.ts";

const EMFILE = 33;
const EINVAL = 28;

export interface WasiOpenDescriptionOptions {
  readonly kind: "file" | "directory" | "symlink" | "stdio";
  readonly mount?: WasiMountedStorage | undefined;
  readonly inode?: Inode | undefined;
  readonly stdio?: WasiStdio | undefined;
  readonly stdioIndex?: 0 | 1 | 2 | undefined;
  readonly byteAccess?: KernelFileByteAccess | undefined;
  readonly byteView?: KernelFileByteView | undefined;
  readonly offset: bigint;
  readonly flags: number;
  readonly directorySnapshot?: DirectoryEntry[] | undefined;
  readonly onLastClose?: () => void | Promise<void>;
}

/** State shared by descriptors that refer to the same open file. */
export class WasiOpenDescription {
  readonly kind: WasiOpenDescriptionOptions["kind"];
  readonly mount: WasiMountedStorage | undefined;
  readonly inode: Inode | undefined;
  readonly stdio: WasiStdio | undefined;
  readonly stdioIndex: 0 | 1 | 2 | undefined;
  readonly byteAccess: KernelFileByteAccess | undefined;
  readonly byteView: KernelFileByteView | undefined;

  #offset: bigint;
  #flags: number;
  #directorySnapshot: DirectoryEntry[] | undefined;
  readonly #onLastClose: (() => void | Promise<void>) | undefined;
  #references = 1;
  #released = false;
  readonly #offsetLock = new KernelIoLock();

  constructor(options: WasiOpenDescriptionOptions) {
    if (options.kind !== "stdio" && (options.mount === undefined || options.inode === undefined)) {
      throw new WasiError(EINVAL);
    }
    this.kind = options.kind;
    this.mount = options.mount;
    this.inode = options.inode;
    this.stdio = options.stdio;
    this.stdioIndex = options.stdioIndex;
    this.byteAccess = options.byteAccess;
    this.byteView = options.byteView;
    this.#offset = options.offset;
    this.#flags = options.flags;
    this.#directorySnapshot = options.directorySnapshot;
    this.#onLastClose = options.onLastClose;
  }

  get offset(): bigint {
    return this.#offset;
  }

  set offset(value: bigint) {
    this.#offset = value;
  }

  get flags(): number {
    return this.#flags;
  }

  set flags(value: number) {
    this.#flags = value;
  }

  get directorySnapshot(): DirectoryEntry[] | undefined {
    return this.#directorySnapshot;
  }

  set directorySnapshot(value: DirectoryEntry[] | undefined) {
    this.#directorySnapshot = value;
  }

  retain(): void {
    if (this.#released || this.#references === 0) {
      throw new Error("Cannot retain a released WASI open description");
    }
    if (this.#references >= Number.MAX_SAFE_INTEGER) {
      throw new WasiError(EMFILE);
    }
    this.#references++;
  }

  /** Undoes an unpublished retain during an atomic table operation. */
  rollbackRetain(): void {
    if (this.#released || this.#references <= 1) {
      throw new Error("Cannot roll back a published WASI descriptor reference");
    }
    this.#references--;
  }

  *release(): WasiCall<void> {
    if (this.#references === 0 || this.#released) {
      throw new Error("WASI open description released more than once");
    }
    this.#references--;
    if (this.#references !== 0) return;

    // A failed backend cleanup consumes the pin too. Closing the descriptor
    // must never restore a reference whose Storage.release() already ran.
    this.#released = true;
    const errors: unknown[] = [];
    if (this.byteAccess !== undefined) {
      try {
        this.byteAccess.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.mount !== undefined && this.inode !== undefined) {
      try {
        yield* complete(this.mount.storage.release(this.inode));
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#onLastClose !== undefined) {
      try {
        yield* complete(this.#onLastClose());
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "WASI open-description cleanup failed");
    }
  }

  // signalbox: a child continuation re-enters the same open-description lock.
  *withOffset<T>(operation: () => WasiCall<T>, owner?: object): WasiCall<T> {
    return yield* this.#offsetLock.with(operation, owner);
  }

  *withWrite<T>(operation: () => WasiCall<T>, owner: object = {}): WasiCall<T> {
    const release = yield* this.acquireIo(owner, true);
    try {
      return yield* operation();
    } finally {
      release();
    }
  }

  *acquireIo(owner: object, write: boolean, signal?: AbortSignal): WasiCall<() => void> {
    const releaseOffset = yield* this.#offsetLock.acquire(owner, signal);
    let acquired = false;
    try {
      const releaseInode =
        write && this.kind === "file" && this.mount !== undefined && this.inode !== undefined
          ? yield* acquireKernelFileWrite(this.mount.storage, this.inode, owner, signal)
          : () => {};
      acquired = true;
      return () => {
        releaseInode();
        releaseOffset();
      };
    } finally {
      if (!acquired) releaseOffset();
    }
  }
}
