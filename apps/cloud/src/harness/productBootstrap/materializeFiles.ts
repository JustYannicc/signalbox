import { createHostStorage } from "../host/storage.ts";
import type { HarnessHostFilesOptions } from "../HarnessSessionHost.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import type { HarnessFilesStoreResult } from "../durableState/files/contracts.ts";
import { validateHarnessCProductFiles } from "./filesCheckpoint.ts";

type ProductHostFiles = Omit<HarnessHostFilesOptions, "wakes" | "stdio">;

/** Writes and reads back the checkpoint bytes in the new facet's storage before host seeding. */
export function materializeHarnessCProductFiles(input: {
  readonly files: ProductHostFiles;
  readonly threadId: string;
  readonly checkpoint: HarnessFilesStoreResult;
}): void {
  validateHarnessCProductFiles(input.checkpoint.files);
  const wakes = new KernelWakeRegistry();
  let storage: ReturnType<typeof createHostStorage> | undefined;
  try {
    storage = createHostStorage({ ...input.files, wakes }, input.threadId);
    const fs = createNodeFs(storage.files).fs;
    for (const file of input.checkpoint.files) {
      const slash = file.path.lastIndexOf("/");
      const parent = slash === -1 ? "." : slash === 0 ? "/" : file.path.slice(0, slash);
      if (slash !== -1) fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
      fs.writeFileSync(file.path, file.bytes, { mode: file.mode });
      fs.chmodSync(file.path, file.mode);
      const restored = fs.readFileSync(file.path);
      const mode = fs.statSync(file.path).mode & 0o7777;
      if (typeof restored === "string" || !sameBytes(restored, file.bytes) || mode !== file.mode)
        throw new Error("The restored checkpoint file differs from A's committed bytes or mode.");
    }
  } catch (cause) {
    throw new Error("A's committed files could not be materialized in the new facet.", { cause });
  } finally {
    try {
      storage?.dispose();
    } finally {
      wakes.dispose();
    }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Captures the selected canonical files for a checkpoint producer in this facet. */
export function captureHarnessCProductFiles(input: {
  readonly files: ProductHostFiles;
  readonly threadId: string;
  readonly paths: readonly string[];
}): HarnessFilesStoreResult["files"] {
  const wakes = new KernelWakeRegistry();
  let storage: ReturnType<typeof createHostStorage> | undefined;
  try {
    storage = createHostStorage({ ...input.files, wakes }, input.threadId);
    const fs = createNodeFs(storage.files).fs;
    return input.paths.map((path) => {
      const bytes = fs.readFileSync(path);
      if (typeof bytes === "string")
        throw new Error("Checkpoint capture requires binary file bytes.");
      return { path, mode: fs.statSync(path).mode & 0o7777, bytes: Uint8Array.from(bytes) };
    });
  } finally {
    try {
      storage?.dispose();
    } finally {
      wakes.dispose();
    }
  }
}
