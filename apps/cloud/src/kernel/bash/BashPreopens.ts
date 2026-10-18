// Nimbus preserves wasi-libc's cached namespace when a shell redirection claims its fd.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import { runAsync } from "../wasi/internal_wasi_calls.ts";
import type { WasiDescriptorTable } from "../wasi/internal_wasi_descriptors.ts";
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

  constructor(descriptors: WasiDescriptorTable, parent?: BashPreopens) {
    this.#descriptors = descriptors;
    this.#moved = new Map(parent === undefined ? undefined : parent.#moved);
  }

  readonly transformArguments: WasiImportArgumentTransform = (name, args) => {
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
    const displaced = descriptors.has(target) ? descriptors.get(target) : undefined;
    const moved = displaced?.preopen === true ? descriptors.duplicate(target) : undefined;
    try {
      const result = await runAsync(descriptors.duplicateTo(source, target));
      if (moved !== undefined) {
        for (const [from, to] of this.#moved) if (to === target) this.#moved.set(from, moved);
        this.#moved.set(target, moved);
      }
      return result;
    } catch (error) {
      if (moved !== undefined) await runAsync(descriptors.close(moved));
      throw error;
    }
  }
}
