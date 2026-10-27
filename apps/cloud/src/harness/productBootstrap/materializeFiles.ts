import { createHostStorage } from "../host/storage.ts";
import type { HarnessHostFilesOptions } from "../HarnessSessionHost.ts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
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
    const fs = createNodeFs(storage.files).fs;
    for (const file of input.checkpoint.files) {
      const slash = file.path.lastIndexOf("/");
      const parent = slash === -1 ? "." : slash === 0 ? "/" : file.path.slice(0, slash);
      if (slash !== -1) fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
      const existing = lstatIfPresent(fs, file.path);
      if (file.kind === "symlink") {
        const target = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          file.bytes,
        );
        if (target.length === 0 || target.includes("\0"))
          throw new Error("A checkpoint symlink has an invalid target.");
        if (existing) fs.unlinkSync(file.path);
        fs.symlinkSync(target, file.path);
        storage.files.chmod(file.path, file.mode, false);
      } else {
        if (existing?.isSymbolicLink()) fs.unlinkSync(file.path);
        fs.writeFileSync(file.path, file.bytes, { mode: file.mode });
        fs.chmodSync(file.path, file.mode);
      }
      const metadata = fs.lstatSync(file.path);
      const restored =
        file.kind === "symlink"
          ? fs.readlinkSync(file.path, { encoding: "buffer" })
          : fs.readFileSync(file.path);
      if (
        metadata.isSymbolicLink() !== (file.kind === "symlink") ||
        typeof restored === "string" ||
        !sameBytes(restored, file.bytes) ||
        (metadata.mode & 0o7777) !== file.mode
      )
        throw new Error(
          "The restored checkpoint entry differs from its committed bytes, kind or mode.",
        );
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

function lstatIfPresent(fs: ReturnType<typeof createNodeFs>["fs"], path: string) {
  try {
    return fs.lstatSync(path);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
    return undefined;
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
      const metadata = fs.lstatSync(path);
      if (!metadata.isFile() && !metadata.isSymbolicLink())
        throw new Error("Checkpoint capture requires a regular file or symlink.");
      const bytes = metadata.isSymbolicLink()
        ? fs.readlinkSync(path, { encoding: "buffer" })
        : fs.readFileSync(path);
      if (typeof bytes === "string")
        throw new Error("Checkpoint capture requires binary file bytes.");
      return {
        path,
        mode: metadata.mode & 0o7777,
        ...(metadata.isSymbolicLink() ? { kind: "symlink" as const } : {}),
        bytes: Uint8Array.from(bytes),
      };
    });
  } finally {
    try {
      storage?.dispose();
    } finally {
      wakes.dispose();
    }
  }
}
