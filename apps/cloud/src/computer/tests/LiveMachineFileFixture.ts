import { vi } from "vite-plus/test";
import type { MachineFileLookupInput, MachineFilesPort } from "../MachineFilesPort.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import { controlledMachineFiles } from "./MachinePathControlledFiles.ts";

export function liveMachineInventory(prefix = "/usr", count = 1): MachineProgramInventory {
  const base = machineInventoryFixture([
    { path: `${prefix}/bin/tool`, mode: 0o777, uid: 1000, gid: 1000 },
    { path: `${prefix}/share/tool`, mode: 0o755, uid: 1000, gid: 1000 },
  ]);
  const link = base.entries.find(({ path }) => path === `${prefix}/bin/tool`)!;
  return {
    ...base,
    entries: [
      ...base.entries.filter(({ path }) => path !== link.path),
      { ...link, path: "/bin", type: "symlink" as const, target: `${prefix.slice(1)}/bin` },
      ...Array.from({ length: count }, (_, index) => ({
        ...link,
        path: `${prefix}/bin/${count === 1 ? "tool" : `tool${index}`}`,
        type: "symlink" as const,
        target: "../share/tool",
      })),
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

/** Replies contain the native wire fields only; adapter-derived provenance is never supplied. */
export function liveMachineFileFixture(inventory = liveMachineInventory()) {
  let raw = controlledMachineFiles(inventory);
  let generation = 1;
  const owner = new AbortController();
  const respond = async (input: MachineFileLookupInput, signal: AbortSignal) => {
    const reply = await raw.files.lookup({ ...input, generation: 1 }, signal);
    return {
      generation: input.generation,
      results: reply.results.map((result) => {
        if ("stat" in result) {
          const typeBits =
            result.stat.type === "symlink"
              ? 0o120000
              : result.stat.type === "directory"
                ? 0o040000
                : 0o100000;
          return { ...result, stat: { ...result.stat, mode: result.stat.mode | typeBits } };
        }
        return result;
      }),
    };
  };
  const lookup = vi.fn<MachineFilesPort["lookup"]>(respond);
  const files: MachineFilesPort = {
    current: () => ({ generation, pristine: false }),
    markExecuted: async () => {},
    lookup,
  };
  return {
    files,
    owner,
    respond,
    lookup,
    replace(next: MachineProgramInventory) {
      raw = controlledMachineFiles(next);
      generation++;
    },
    changeGeneration() {
      generation++;
    },
  };
}
