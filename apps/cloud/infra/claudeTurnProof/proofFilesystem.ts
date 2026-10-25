// @effect-diagnostics globalDate:off - the Durable Object owns the proof filesystem clock.
import { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createMemoryFilePersistencePorts } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createNodeFs } from "../../src/isolate/NodeFs.ts";

const PROOF_ROOT = Object.freeze({ mode: 0o755, uid: 1000, gid: 1000 });
const PROOF_UMASK = 0o022;

/** Builds the canonical SQLite-backed filesystem shared by Node, Bun and kernel programs. */
export function createProofFilesystemHost(storage: FacetStorage) {
  const wakes = new KernelWakeRegistry();
  const ports = createMemoryFilePersistencePorts();
  const persistence = createFacetFilePersistence(storage, () => BigInt(Date.now()) * 1_000_000n, {
    wakes,
    ports,
  });
  const root = rootMetadata(persistence.storage);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    cwd: "/",
    posix: {
      credentials: {
        uid: root.uid,
        gid: root.gid,
        euid: root.uid,
        egid: root.gid,
      },
      umask: PROOF_UMASK,
    },
  });
  const fs = createNodeFs(filesystem);
  for (const directory of ["/work", "/home/claude", "/tmp", "/usr/local/bin", "/usr/bin", "/bin"]) {
    fs.fs.mkdirSync(directory, { recursive: true });
  }
  filesystem.chdir("/work");
  return { wakes, ports, persistence, filesystem, fs };
}

function rootMetadata(storage: ReturnType<typeof createFacetFilePersistence>["storage"]) {
  try {
    return storage.posix.get(storage.root);
  } catch (error) {
    if (!hasCode(error, "ENOTSUP")) throw error;
    try {
      storage.posix.initialize(storage.root, PROOF_ROOT);
    } catch (initializeError) {
      if (!hasCode(initializeError, "EEXIST")) throw initializeError;
    }
    return storage.posix.get(storage.root);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code
  );
}
