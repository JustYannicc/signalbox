// Nimbus preserves wasi-libc's cached namespace when a shell redirection claims its fd.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import { runAsync } from "../wasi/internal_wasi_calls.ts";
import type { WasiDescriptor, WasiDescriptorTable } from "../wasi/internal_wasi_descriptors.ts";
import type { WasiImportArgumentTransform } from "../wasi/internal_wasi_lifecycle.ts";

const DIRECTORY_ARGUMENTS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  fd_prestat_get: [0],
  fd_prestat_dir_name: [0],
  fd_fdstat_get: [0],
  path_open: [0],
  path_create_directory: [0],
  path_filestat_get: [0],
  path_filestat_set_times: [0],
  path_unlink_file: [0],
  path_rename: [0, 3],
  path_readlink: [0],
  path_symlink: [2],
  path_link: [0, 4],
  path_remove_directory: [0],
});

/** Guest libc's cached fd operands, backed by handles in the canonical table. */
export class BashPreopens {
  readonly #descriptors: WasiDescriptorTable;
  readonly #moved: Map<number, number>;
  readonly #cached: ReadonlySet<number>;

  constructor(descriptors: WasiDescriptorTable, parent?: BashPreopens) {
    this.#descriptors = descriptors;
    this.#moved = new Map(parent === undefined ? undefined : parent.#moved);
    this.#cached =
      parent === undefined
        ? new Set(
            [...descriptors.entries()]
              .filter(([, descriptor]) => descriptor.preopen)
              .map(([fd]) => fd),
          )
        : parent.#cached;
  }

  readonly transformArguments: WasiImportArgumentTransform = (name, args) => {
    if (name === "fd_close" && typeof args[0] === "number") {
      const target = args[0] >>> 0;
      const retained = this.#retain(target);
      if (retained !== undefined) this.#remember(target, retained.fd);
      return args;
    }
    const indexes = DIRECTORY_ARGUMENTS[name];
    if (indexes === undefined) return args;
    let transformed: (number | bigint)[] | undefined;
    for (const index of indexes) {
      const fd = args[index];
      if (typeof fd !== "number") continue;
      const moved = this.#moved.get(fd >>> 0);
      if (moved === undefined) continue;
      transformed ??= [...args];
      transformed[index] = moved;
    }
    return transformed ?? args;
  };

  async duplicateTo(source: number, target: number): Promise<number> {
    const descriptors = this.#descriptors;
    descriptors.get(source);
    if (source === target) return target;
    const retained = this.#retain(target);
    try {
      const result = await runAsync(descriptors.duplicateTo(source, target));
      if (retained !== undefined) this.#remember(target, retained.fd);
      return result;
    } catch (error) {
      if (retained?.created) await runAsync(descriptors.close(retained.fd));
      throw error;
    }
  }

  #retain(target: number): { fd: number; created: boolean } | undefined {
    const referenced = this.#cached.has(target) || [...this.#moved.values()].includes(target);
    if (!referenced || !this.#descriptors.has(target)) return;
    const displaced = this.#descriptors.get(target);
    if (!displaced.preopen) return;
    for (const fd of this.#moved.values()) {
      if (
        fd !== target &&
        this.#descriptors.has(fd) &&
        samePreopen(displaced, this.#descriptors.get(fd))
      )
        return { fd, created: false };
    }
    return { fd: this.#descriptors.duplicate(target), created: true };
  }

  #remember(target: number, retained: number): void {
    for (const [from, to] of this.#moved) if (to === target) this.#moved.set(from, retained);
    if (this.#cached.has(target)) this.#moved.set(target, retained);
  }
}

function samePreopen(left: WasiDescriptor, right: WasiDescriptor): boolean {
  return (
    right.preopen === true &&
    left.mount === right.mount &&
    left.inode === right.inode &&
    left.capabilityRoot === right.capabilityRoot &&
    left.preopenPath === right.preopenPath &&
    left.rightsBase === right.rightsBase &&
    left.rightsInheriting === right.rightsInheriting
  );
}
