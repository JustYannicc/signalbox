// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Inode, DirectoryEntry } from "../storage.ts";
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
  readonly offset: bigint;
  readonly flags: number;
  readonly directorySnapshot?: DirectoryEntry[] | undefined;
  readonly onLastClose?: () => void | Promise<void>;
}

interface OffsetWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  state: "queued" | "granted" | "cancelled" | "released";
}

/** State shared by descriptors that refer to the same open file. */
export class WasiOpenDescription {
  readonly kind: WasiOpenDescriptionOptions["kind"];
  readonly mount: WasiMountedStorage | undefined;
  readonly inode: Inode | undefined;
  readonly stdio: WasiStdio | undefined;
  readonly stdioIndex: 0 | 1 | 2 | undefined;

  #offset: bigint;
  #flags: number;
  #directorySnapshot: DirectoryEntry[] | undefined;
  readonly #onLastClose: (() => void | Promise<void>) | undefined;
  #references = 1;
  #released = false;
  #offsetBusy = false;
  #offsetWaiters: OffsetWaiter[] = [];

  constructor(options: WasiOpenDescriptionOptions) {
    if (options.kind !== "stdio" && (options.mount === undefined || options.inode === undefined)) {
      throw new WasiError(EINVAL);
    }
    this.kind = options.kind;
    this.mount = options.mount;
    this.inode = options.inode;
    this.stdio = options.stdio;
    this.stdioIndex = options.stdioIndex;
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
    try {
      if (this.mount !== undefined && this.inode !== undefined) {
        try {
          yield* complete(this.mount.storage.release(this.inode));
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      if (this.#onLastClose !== undefined) {
        try {
          yield* complete(this.#onLastClose());
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "WASI open-description cleanup failed");
    }
  }

  *withOffset<T>(operation: () => WasiCall<T>): WasiCall<T> {
    if (!this.#offsetBusy) {
      this.#offsetBusy = true;
      try {
        return yield* operation();
      } finally {
        this.#unlockOffset();
      }
    }

    const waiter = this.#enqueueOffsetWaiter();
    let acquired = false;
    try {
      yield waiter.promise;
      acquired = true;
      return yield* operation();
    } finally {
      if (acquired || waiter.state === "granted") {
        waiter.state = "released";
        this.#unlockOffset();
      } else {
        this.#cancelOffsetWaiter(waiter);
      }
    }
  }

  #enqueueOffsetWaiter(): OffsetWaiter {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => {
      resolve = finish;
    });
    const waiter: OffsetWaiter = { promise, resolve, state: "queued" };
    this.#offsetWaiters.push(waiter);
    return waiter;
  }

  #cancelOffsetWaiter(waiter: OffsetWaiter): void {
    if (waiter.state !== "queued") return;
    waiter.state = "cancelled";
    const index = this.#offsetWaiters.indexOf(waiter);
    if (index !== -1) this.#offsetWaiters.splice(index, 1);
  }

  #unlockOffset(): void {
    while (this.#offsetWaiters.length > 0) {
      const waiter = this.#offsetWaiters.shift();
      if (waiter === undefined) break;
      if (waiter.state !== "queued") continue;
      waiter.state = "granted";
      waiter.resolve();
      return;
    }
    this.#offsetBusy = false;
  }
}
