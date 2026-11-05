import { createHostStorage } from "../host/storage.ts";
import type { HarnessHostFilesOptions } from "../HarnessSessionHost.ts";
import {
  materializeKernelCheckpointFiles,
  captureKernelCheckpointFiles,
} from "../../kernel/KernelCheckpointFiles.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import type { HarnessFilesStoreResult } from "../durableState/files/contracts.ts";
import { validateHarnessCProductFiles } from "./filesCheckpoint.ts";

type ProductHostFiles = Omit<HarnessHostFilesOptions, "wakes" | "stdio">;

/** Verifies restored files and links before the new facet seeds its host. */
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
    materializeKernelCheckpointFiles(storage.files, input.checkpoint.files);
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
    return captureKernelCheckpointFiles(storage.files, input.paths);
  } finally {
    try {
      storage?.dispose();
    } finally {
      wakes.dispose();
    }
  }
}
