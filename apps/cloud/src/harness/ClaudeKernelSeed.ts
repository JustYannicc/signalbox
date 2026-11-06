import type { ClaudeKernelSeedSource } from "./ClaudeKernelBindings.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { SeedCatalog } from "../kernel/KernelSeedCatalog.ts";
import { KERNEL_FILE_TRANSFER_BYTES } from "../kernel/KernelFileTransferPort.ts";

async function readVerified(
  entry: { readonly path: string; readonly bytes: number; readonly sha256: string },
  read: (offset: number, length: number) => Promise<Uint8Array>,
  signal: AbortSignal,
) {
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
    throw new RangeError("Invalid kernel seed length");
  const bytes = new Uint8Array(entry.bytes);
  for (let offset = 0; offset < bytes.length; offset += KERNEL_FILE_TRANSFER_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(KERNEL_FILE_TRANSFER_BYTES, bytes.length - offset);
    const chunk = await read(offset, length);
    if (chunk.length !== length) throw new Error("Kernel seed range ended early");
    bytes.set(chunk, offset);
  }
  signal.throwIfAborted();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== entry.sha256) throw new Error("Kernel seed hash differs from the verified release");
  return bytes;
}

export async function readClaudeKernelRelease(
  plan: LoadedHarnessRelease["plan"],
  source: ClaudeKernelSeedSource,
  signal: AbortSignal,
): Promise<LoadedHarnessRelease> {
  const payloads = new Map<string, Uint8Array>();
  for (const entry of [
    ...plan.assets,
    ...(plan.harness === "claude-code" ? plan.moduleMaps : []),
  ]) {
    if (!payloads.has(entry.path))
      payloads.set(
        entry.path,
        await readVerified(
          entry,
          (offset, length) => source.releasePayload(entry.path, offset, length),
          signal,
        ),
      );
  }
  return { plan, payloads };
}

export function remoteKernelSeedCatalog(
  catalog: Pick<SeedCatalog, "id" | "stages">,
  source: ClaudeKernelSeedSource,
): SeedCatalog {
  return {
    ...catalog,
    async payloads(stage, signal) {
      try {
        const payloads = new Map<string, Uint8Array>();
        for (const entry of catalog.stages[stage])
          payloads.set(
            entry.path,
            await readVerified(
              entry,
              (offset, length) => source.read(stage, entry.path, offset, length),
              signal,
            ),
          );
        return payloads;
      } finally {
        await source.release(stage);
      }
    },
  };
}
