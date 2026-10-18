// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { AsyncStorage, Mount, Storage } from "../storage.ts";
import { WasiError, WasiMemory } from "./internal_wasi_memory.ts";
import { complete, type WasiCall } from "./internal_wasi_calls.ts";
import {
  ALL_RIGHTS,
  READ_ONLY_RIGHTS,
  type WasiDescriptor,
  type WasiStdio,
  WasiDescriptorTable,
} from "./internal_wasi_descriptors.ts";
import {
  normalizeMounts,
  type WasiMountedStorage,
  WasiPathResolver,
} from "./internal_wasi_paths.ts";
import { WasiFdCalls } from "./internal_wasi_fd_calls.ts";
import { WasiPathCalls } from "./internal_wasi_path_calls.ts";

export { complete, type WasiCall } from "./internal_wasi_calls.ts";
export { WasiDescriptorTable } from "./internal_wasi_descriptors.ts";
export type { WasiDescriptor, WasiPollResult, WasiStdio } from "./internal_wasi_descriptors.ts";

const ENOTDIR = 54;
const EINVAL = 28;

/** Internal process integration; an inherited table defines every guest fd. */
export interface WasiDescriptorContext {
  readonly table: WasiDescriptorTable;
  readonly ownership: "owned" | "borrowed";
}

/** Composes the preview1 descriptor, file, and path syscall adapters. */
export class WasiFileSystem {
  readonly descriptors: WasiDescriptorTable;
  readonly imports: WasiFdCalls["imports"] & WasiPathCalls["imports"];
  readonly #mounts: WasiMountedStorage[];
  readonly #fdCalls: WasiFdCalls;
  readonly #pathCalls: WasiPathCalls;
  readonly #paths: WasiPathResolver;
  readonly #ownsDescriptors: boolean;
  #initialized = false;
  #initializing = false;
  #closed = false;

  constructor(
    memory: WasiMemory,
    mounts: Mount<Storage | AsyncStorage>[],
    stdio: WasiStdio[],
    descriptorContext?: WasiDescriptorContext,
  ) {
    this.#mounts = descriptorContext === undefined ? normalizeMounts(mounts) : [];
    this.descriptors = descriptorContext?.table ?? new WasiDescriptorTable(stdio);
    this.#ownsDescriptors = descriptorContext?.ownership !== "borrowed";
    this.#paths = new WasiPathResolver(complete);
    this.#fdCalls = new WasiFdCalls(memory, this.descriptors);
    this.#pathCalls = new WasiPathCalls(memory, this.descriptors, this.#paths);
    this.imports = Object.assign(
      Object.create(null) as Record<string, unknown>,
      this.#fdCalls.imports,
      this.#pathCalls.imports,
    );
  }

  *initialize(): WasiCall<void> {
    if (this.#initialized || this.#initializing || this.#closed) {
      throw new WasiError(EINVAL);
    }
    this.#initializing = true;
    const added: number[] = [];
    try {
      for (const mount of this.#mounts) {
        const stat = yield* complete(mount.storage.stat(mount.root));
        if (stat.type !== "directory") throw new WasiError(ENOTDIR);
      }
      for (const mount of this.#mounts) {
        yield* complete(mount.storage.retain(mount.root));
        try {
          const fd = this.descriptors.allocate({
            kind: "directory",
            mount,
            inode: mount.root,
            capabilityRoot: mount.root,
            ancestors: [mount.root],
            pathComponents: [],
            preopenPath: mount.path,
            preopen: true,
            offset: 0n,
            rightsBase: mount.readOnly ? READ_ONLY_RIGHTS : ALL_RIGHTS,
            rightsInheriting: mount.readOnly ? READ_ONLY_RIGHTS : ALL_RIGHTS,
            flags: 0,
          });
          added.push(fd);
        } catch (error) {
          try {
            yield* complete(mount.storage.release(mount.root));
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "WASI preopen setup and cleanup failed",
            );
          }
          throw error;
        }
      }
      this.#initialized = true;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const fd of added.reverse()) {
        try {
          yield* this.descriptors.close(fd);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "WASI initialization and cleanup failed",
        );
      }
      throw error;
    } finally {
      this.#initializing = false;
    }
  }

  *close(): WasiCall<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsDescriptors) yield* this.descriptors.closeAll();
  }

  getDescriptor(fd: number): WasiDescriptor {
    return this.descriptors.get(fd);
  }
}
