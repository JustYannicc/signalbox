import type { MachineFilesPort } from "./MachineFilesPort.ts";
import type {
  MachineImageDigest,
  MachineProgramEntry,
  MachineProgramInventory,
} from "./MachineProgramInventory.ts";

/** A deliberately empty machine for product-host tests that provide their own command receipts. */
export function emptyMachineFilesFixture(): MachineFilesPort {
  let pristine = true;
  return {
    current: () => ({
      generation: 1,
      pristine,
      ...(pristine ? { imageDigest: `sha256:${"0".repeat(64)}` } : {}),
    }),
    markExecuted: async () => {
      pristine = false;
    },
    async lookup(input) {
      return {
        generation: input.generation,
        results: input.operations.map((operation) => ({
          id: operation.id,
          op: operation.op,
          error: { code: "ENOENT", message: "Controlled machine path is absent" },
        })),
      };
    },
  };
}

export function machineInventoryFixture(
  files: readonly Pick<MachineProgramEntry, "path" | "mode" | "uid" | "gid">[] = [],
): MachineProgramInventory {
  const entries = new Map<string, MachineProgramEntry>();
  const entry = (
    path: string,
    type: MachineProgramEntry["type"],
    mode: number,
    uid: number,
    gid: number,
  ): MachineProgramEntry => ({
    path,
    type,
    mode,
    uid,
    gid,
    size: "0",
    nlink: "1",
    atimeNs: "0",
    mtimeNs: "0",
    ctimeNs: "0",
  });
  entries.set("/", entry("/", "directory", 0o755, 0, 0));
  for (const file of files) {
    let parent = file.path.slice(0, file.path.lastIndexOf("/")) || "/";
    while (!entries.has(parent)) {
      entries.set(parent, entry(parent, "directory", 0o755, 0, 0));
      parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
    }
    entries.set(file.path, entry(file.path, "file", file.mode, file.uid, file.gid));
  }
  const digest = `sha256:${"0".repeat(64)}` as MachineImageDigest;
  return {
    format: "signalbox-machine-files-v1",
    imageRef: `fixture.invalid/runner@${digest}`,
    imageDigest: digest,
    platform: "linux/amd64",
    provenance: {
      sourceRevision: "0".repeat(40),
      sourceImageId: digest,
      dockerfile: "controlled fixture",
      captureSha256: "0".repeat(64),
    },
    path: ["/bin", "/usr/bin"],
    excludedRoots: [],
    entries: [...entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
}
