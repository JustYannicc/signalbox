import { isPosixMetadata } from "../kernel/PosixStorage.ts";
import runner from "./machinePrograms/runner.json" with { type: "json" };

export interface MachineProgramEntry {
  readonly path: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  /** Absolute resolved target, including the image's merged-/usr directory aliases. */
  readonly target?: string;
}

/** Captured as the machine command user, after image installation. No machine is started for lookup. */
export interface MachineProgramInventory {
  readonly image: string;
  readonly path: readonly string[];
  readonly entries: readonly MachineProgramEntry[];
}

export const RUNNER_MACHINE_PROGRAM_INVENTORY = snapshotMachinePrograms(runner);

export function snapshotMachinePrograms(
  inventory: MachineProgramInventory,
): MachineProgramInventory {
  if (
    !inventory ||
    typeof inventory.image !== "string" ||
    !inventory.image ||
    !Array.isArray(inventory.path) ||
    !Array.isArray(inventory.entries)
  )
    throw new TypeError("Machine executable inventory is required");
  const paths = new Set<string>();
  const entries = inventory.entries.map((entry: MachineProgramEntry) => {
    if (
      !entry ||
      !isPosixMetadata(entry) ||
      !canonical(entry.path) ||
      paths.has(entry.path) ||
      (entry.mode & 0o111) === 0 ||
      (entry.target !== undefined && !canonical(entry.target))
    )
      throw new TypeError("Invalid machine executable inventory entry");
    paths.add(entry.path);
    return Object.freeze({ ...entry });
  });
  for (const entry of entries) {
    if (entry.target === undefined) continue;
    const target = entries.find((candidate) => candidate.path === entry.target);
    if (target === undefined || target.target !== undefined)
      throw new TypeError("Machine executable link must resolve to an inventoried file");
  }
  const path = inventory.path.map((directory: string) => {
    if (directory !== "/" && !canonical(directory)) throw new TypeError("Invalid machine PATH");
    return directory;
  });
  return Object.freeze({
    image: inventory.image,
    path: Object.freeze(path),
    entries: Object.freeze(entries),
  });
}

function canonical(path: string) {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.includes("\0") &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
