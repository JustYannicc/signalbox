// @effect-diagnostics nodeBuiltinImport:off - Each test owns an in-memory SQLite database.
import * as NodeSqlite from "node:sqlite";
import type { FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { createFacetFilePersistence } from "../../../kernel/FacetFilePersistence.ts";
import type { FileHydrationPort, ForkCommit } from "../../../kernel/FilePersistencePorts.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelAbi.ts";
import { KernelFileSystem, type WasiStdio } from "../../../kernel/KernelFileSystem.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createNodeFs } from "../../NodeFs.ts";

export const base: ForkCommit = { repository: "fixture", fork: "test", commit: "base" };
export const milestone = () => Promise.withResolvers<void>();
type MemoryPorts = ReturnType<typeof createMemoryFilePersistencePorts>;

export function hydrationFixture(
  options: {
    fetch?: (
      input: Parameters<FileHydrationPort["fetch"]>[0],
      memory: MemoryPorts,
    ) => ReturnType<FileHydrationPort["fetch"]>;
    stdio?: readonly [WasiStdio, WasiStdio, WasiStdio];
  } = {},
) {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  const storage: FacetStorage = {
    sql: {
      databaseSize: 0,
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const args = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      },
    },
    transactionSync(operation) {
      database.exec("SAVEPOINT node_fs_hydration");
      try {
        const value = operation();
        database.exec("RELEASE node_fs_hydration");
        return value;
      } catch (error) {
        database.exec("ROLLBACK TO node_fs_hydration");
        database.exec("RELEASE node_fs_hydration");
        throw error;
      }
    },
  };
  const memory = createMemoryFilePersistencePorts();
  const wakes = new KernelWakeRegistry();
  const requests: Parameters<FileHydrationPort["fetch"]>[0][] = [];
  const fetches: Promise<unknown>[] = [];
  const persistence = createFacetFilePersistence(storage, () => 1_800_000_000_000_000_000n, {
    wakes,
    ports: {
      commits: memory.commits,
      hydration: {
        fetch(input) {
          requests.push(input);
          const result = options.fetch
            ? options.fetch(input, memory)
            : memory.hydration.fetch(input);
          fetches.push(result);
          return result;
        },
      },
    },
  });
  const kernelFs = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    ...(options.stdio ? { stdio: options.stdio } : {}),
    cwd: "/",
  });
  const { fs } = createNodeFs(kernelFs, undefined, persistence.runLeaf);
  return {
    fs,
    kernelFs,
    persistence,
    wakes,
    memory,
    requests,
    mark(path: string, contents: string) {
      const bytes = new TextEncoder().encode(contents);
      memory.seedFile(base, path, bytes);
      const inode = persistence.storage.create(persistence.storage.root, path.slice(1), {
        type: "file",
        exclusive: true,
      });
      if (typeof inode !== "bigint") throw new Error("Expected synchronous SQLite storage");
      persistence.storage.truncate(inode, BigInt(bytes.byteLength));
      persistence.markUnhydrated({ inode, path, at: base, size: BigInt(bytes.byteLength) });
      return inode;
    },
    async close() {
      persistence.dispose();
      await Promise.allSettled(fetches);
      kernelFs.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

export function delayedFixture() {
  const started = milestone();
  const release = milestone();
  const fixture = hydrationFixture({
    async fetch(input, memory) {
      started.resolve();
      await release.promise;
      return memory.hydration.fetch(input);
    },
  });
  return {
    ...fixture,
    started,
    release,
    async close() {
      release.resolve();
      await fixture.close();
    },
  };
}
