import type { MachineFilesPort } from "../../../../computer/MachineFilesPort.ts";
import type { MachineProgramInventory } from "../../../../computer/MachineProgramInventory.ts";

/** This machine's command changes no image metadata. Keep its live lookup consistent
 * with the image after the first command marks the generation dirty. */
export function productMachineFiles(inventory: MachineProgramInventory): MachineFilesPort {
  let pristine = true;
  return {
    current: () => ({ generation: 1, pristine, imageDigest: inventory.imageDigest }),
    markExecuted: async () => {
      pristine = false;
    },
    lookup: async ({ generation, operations }) => ({
      generation,
      results: operations.map((operation) => {
        const path = "path" in operation ? operation.path : "";
        const entry = inventory.entries.find((entry) => entry.path === path);
        if (entry !== undefined && (operation.op === "stat" || operation.op === "lstat"))
          return { id: operation.id, op: operation.op, stat: entry };
        if (entry?.type === "directory" && operation.op === "readdir")
          return {
            id: operation.id,
            op: operation.op,
            nextCursor: null,
            entries: inventory.entries
              .filter(
                (entry) =>
                  entry.path !== path &&
                  (entry.path.slice(0, entry.path.lastIndexOf("/")) || "/") === path,
              )
              .map((entry) => ({
                name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
                type: entry.type,
                stat: entry,
              })),
          };
        return {
          id: operation.id,
          op: operation.op,
          error: { code: "ENOENT", message: "Controlled machine path is absent" },
        };
      }),
    }),
  };
}
