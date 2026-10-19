// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory test database, never live userdata.
import * as NodeSqlite from "node:sqlite";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { CommitInode, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import { createMemoryFilePersistencePorts } from "../../kernel/MemoryFilePersistencePorts.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
import type { MachineWorkspace } from "../MachineWorkspace.ts";

export const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
const clock = () => 1_800_000_000_000_000_001n;

function sqliteFixture() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  let depth = 0;
  const storage: FacetStorage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const name = `facet_workspace_test_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
  return { storage, close: () => db.close() };
}

export function rig(
  files: readonly { path: string; bytes: Uint8Array }[],
  resume?: NonNullable<MachineWorkspace["resume"]>,
) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const ports = createMemoryFilePersistencePorts();
  for (const { path, bytes } of files) ports.seedFile(base, path, bytes);
  const persistence = createFacetFilePersistence(database.storage, clock, { wakes, ports });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    cwd: "/",
  });
  const workspace = createFacetWorkspace({
    database: database.storage,
    persistence,
    filesystem,
    mountPath: "/",
    initial: base,
    ...(resume ? { resume } : {}),
    mount: async () => {
      throw new Error("The external machine mount is outside this adapter test");
    },
  });
  return {
    ...database,
    ports,
    persistence,
    filesystem,
    workspace,
    close() {
      filesystem.dispose();
      persistence.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

export function makeLocalFile(
  storage: ReturnType<typeof createFacetFilePersistence>["storage"],
  path: string,
  bytes: Uint8Array,
) {
  const name = path.slice(1);
  const inode = storage.create(storage.root, name, { type: "file", exclusive: true });
  storage.write(inode, 0n, bytes);
  storage.posix.initialize(inode, { mode: 0o644, uid: 1000, gid: 1000 });
  return inode;
}

export function fileChange(
  inode: bigint,
  paths: readonly string[],
  removedPaths: readonly string[],
  bytes: Uint8Array,
  posix = { mode: 0o600, uid: 3, gid: 4 },
): CommitInode {
  return {
    inode,
    paths,
    removedPaths,
    stat: {
      type: "file",
      size: BigInt(bytes.byteLength),
      nlink: BigInt(paths.length),
      atimeNs: 20n,
      mtimeNs: 21n,
      ctimeNs: 22n,
    },
    symlinkTarget: null,
    posix,
    async *readChunks() {
      yield bytes;
    },
  };
}

export const commitPort = (ports: ReturnType<typeof createMemoryFilePersistencePorts>) =>
  ports.commits;
