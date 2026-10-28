// @effect-diagnostics nodeBuiltinImport:off - incremental hashing keeps executable bytes bounded.
import * as NodeCrypto from "node:crypto";
import { KernelOpenFlags, type KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { KernelProgramBinding } from "../../kernel/KernelProgramHost.ts";

/** Upper files can be verified WASM seeds or user replacements at the same catalog path. */
export async function isCatalogProgramFile(
  filesystem: KernelFileSystem,
  path: string,
  binding: KernelProgramBinding,
  signal: AbortSignal,
): Promise<boolean> {
  const implementation = binding.implementation;
  if (!("executableArtifact" in implementation)) return false;
  const artifact = implementation.executableArtifact;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("bytes" in artifact) ||
    typeof artifact.bytes !== "number" ||
    !("sha256" in artifact) ||
    typeof artifact.sha256 !== "string"
  )
    return false;
  const fd = await filesystem.openAsync(path, KernelOpenFlags.O_RDONLY, undefined, signal);
  try {
    if (filesystem.fstat(fd).size !== BigInt(artifact.bytes)) return false;
    const hash = NodeCrypto.createHash("sha256");
    const chunk = new Uint8Array(64 * 1024);
    let position = 0;
    while (position < artifact.bytes) {
      const read = await filesystem.readAsync(
        fd,
        chunk.subarray(0, Math.min(chunk.length, artifact.bytes - position)),
        BigInt(position),
        signal,
      );
      if (read === 0) return false;
      hash.update(chunk.subarray(0, read));
      position += read;
    }
    signal.throwIfAborted();
    return hash.digest("hex") === artifact.sha256;
  } finally {
    filesystem.close(fd);
  }
}
