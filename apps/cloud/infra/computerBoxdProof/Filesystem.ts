// @effect-diagnostics globalDate:off - the disposable SQLite fixture timestamps native writes.
import { KernelWakeRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createDurableProofRevisionPorts } from "./DurableRevisionPorts.ts";

export const PROOF_INITIAL_REVISION = Object.freeze({
  repository: "proof-only",
  fork: "owned-proof",
  commit: "initial",
});

/** Reopening this state never hydrates or rewrites the live facet's files. */
export function openProofFilesystem(database: FacetStorage) {
  const wakes = new KernelWakeRegistry();
  const ports = createDurableProofRevisionPorts(database);
  const persistence = createFacetFilePersistence(database, () => BigInt(Date.now()) * 1_000_000n, {
    wakes,
    ports,
  });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    posix: { credentials: { uid: 0, gid: 0, euid: 0, egid: 0 }, umask: 0o022 },
  });
  return {
    filesystem,
    persistence,
    wakes,
    ports,
    write(path: string, bytes: Uint8Array, mode = 0o644) {
      const descriptor = filesystem.open(
        path,
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        mode,
      );
      try {
        filesystem.write(descriptor, bytes, null);
      } finally {
        filesystem.close(descriptor);
      }
    },
    read(descriptor: number) {
      const bytes = new Uint8Array(Number(filesystem.fstat(descriptor).size));
      return bytes.subarray(0, filesystem.read(descriptor, bytes, 0n));
    },
    close() {
      filesystem.dispose();
      persistence.dispose();
      wakes.dispose();
    },
  };
}
