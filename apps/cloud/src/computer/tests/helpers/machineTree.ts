import { createComputerMachineFileSystem } from "../../ComputerMachineFileSystem.ts";
import type { MachineProgramEntry } from "../../MachineProgramInventory.ts";
import {
  emptyMachineFilesFixture,
  machineInventoryFixture,
} from "../../machineInventoryTesting.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";

export interface MachinePath {
  readonly path: string;
  readonly type?: "file" | "directory" | "symlink";
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly target?: string;
  /** Native identity; two files with the same one are hard links. */
  readonly ino?: number;
}

/** A pristine machine image below Computer's files, read from its inventory as in production. */
export function installMachineTree(
  files: KernelFileSystem,
  paths: readonly MachinePath[],
  signal = new AbortController().signal,
) {
  const entries = new Map<string, MachineProgramEntry>();
  const add = (spec: MachinePath) => {
    const type = spec.type ?? (spec.target === undefined ? "file" : "symlink");
    entries.set(spec.path, {
      path: spec.path,
      type,
      mode: spec.mode ?? (type === "directory" ? 0o755 : 0o644),
      uid: spec.uid ?? 0,
      gid: spec.gid ?? 0,
      size: String(spec.target?.length ?? 0),
      nlink: type === "directory" ? "2" : "1",
      atimeNs: "11",
      mtimeNs: "12",
      ctimeNs: "13",
      ...(spec.target === undefined ? {} : { target: spec.target }),
      ...(spec.ino === undefined ? {} : { ino: String(spec.ino), dev: "7" }),
    });
  };
  add({ path: "/", type: "directory" });
  for (const spec of paths) {
    for (let parent = parentOf(spec.path); !entries.has(parent); parent = parentOf(parent))
      add({ path: parent, type: "directory" });
    add(spec);
  }
  const inventory = {
    ...machineInventoryFixture(),
    entries: [...entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
  return files.installLowerFileSystem(
    createComputerMachineFileSystem({ inventory, files: emptyMachineFilesFixture(), signal }),
  );
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
