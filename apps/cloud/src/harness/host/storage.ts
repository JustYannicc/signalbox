import { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { HarnessHostFilesOptions } from "./contracts.ts";
import { ensureDirectory, validateMetadata } from "./seed.ts";

export function createHostStorage(options: HarnessHostFilesOptions, threadId: string) {
  const { database } = options;
  if (!threadId || !options.identity) throw new Error("Host storage identity is required");
  validateMetadata(options.rootMetadata);
  const persistence = database.transactionSync(() => {
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS harness_host_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), thread_id TEXT NOT NULL, filesystem_id TEXT NOT NULL)",
    );
    const row = [
      ...database.sql.exec(
        "SELECT thread_id, filesystem_id FROM harness_host_identity WHERE singleton=1",
      ),
    ][0];
    if (row !== undefined && (row.thread_id !== threadId || row.filesystem_id !== options.identity))
      throw new Error("Host storage identity changed");
    const created = createFacetFilePersistence(database, options.nowNs, {
      wakes: options.wakes,
      ports: options.persistencePorts,
    });
    if (row === undefined) {
      created.storage.posix.initialize(created.storage.root, options.rootMetadata);
      database.sql.exec(
        "INSERT INTO harness_host_identity VALUES (1, ?, ?)",
        threadId,
        options.identity,
      );
    }
    const root = created.storage.posix.get(created.storage.root);
    if (
      root.mode !== options.rootMetadata.mode ||
      root.uid !== options.rootMetadata.uid ||
      root.gid !== options.rootMetadata.gid
    )
      throw new Error("Canonical root metadata changed");
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS harness_seed_receipts (stage TEXT PRIMARY KEY, catalog_id TEXT NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS harness_boot_attempts (thread_id TEXT NOT NULL, attempt_id TEXT NOT NULL, catalog_id TEXT NOT NULL, input_hash TEXT NOT NULL, PRIMARY KEY(thread_id,attempt_id))",
    );
    return created;
  });
  let files: KernelFileSystem | undefined;
  try {
    files = new KernelFileSystem({
      mounts: [{ path: "/", storage: persistence.storage }],
      cwd: "/",
      posix: options.posix,
      ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
    });
    ensureDirectory(files, options.cwd);
    files.chdir(options.cwd);
  } catch (error) {
    try {
      files?.dispose();
    } finally {
      persistence.dispose();
    }
    throw error;
  }
  const canonical = files;
  return {
    files: canonical,
    persistence,
    database,
    dispose() {
      try {
        canonical.dispose();
      } finally {
        persistence.dispose();
      }
    },
  };
}
export type HostStorage = ReturnType<typeof createHostStorage>;
