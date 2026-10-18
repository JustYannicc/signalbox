import type { BunFileHost, BunFileStat, BunFileTarget } from "../../BunShim.ts";
import type { NodeFsModules } from "../../NodeFs.ts";

/** Reuses NodeFs so Bun paths, descriptors, offsets, and errors share the kernel state. */
export function createBunFileHost(filesystem: NodeFsModules): BunFileHost {
  const { fs } = filesystem;

  function stat(target: BunFileTarget): BunFileStat {
    return typeof target === "number" ? fs.fstatSync(target) : fs.statSync(target);
  }

  return {
    async readFile(target) {
      const bytes = await filesystem["fs/promises"].readFile(target);
      if (typeof bytes === "string") throw new TypeError("Binary Bun file read returned text");
      return bytes;
    },
    async writeFile(target, bytes) {
      await filesystem["fs/promises"].writeFile(target, bytes);
    },
    async stat(target) {
      const value =
        typeof target === "number"
          ? fs.fstatSync(target)
          : await filesystem["fs/promises"].stat(target);
      if (typeof value.size !== "number") throw new TypeError("Bun file stat returned bigint size");
      return {
        size: value.size,
        isFile: () => value.isFile(),
        isDirectory: () => value.isDirectory(),
      };
    },
    statSync: stat,
  };
}
