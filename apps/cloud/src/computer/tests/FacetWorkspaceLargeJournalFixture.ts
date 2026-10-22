// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory test database, never live userdata.
import * as NodeSqlite from "node:sqlite";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type {
  FileCommitPort,
  FileHydrationPort,
  FilePersistencePorts,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import { KernelWakeRegistry } from "../../kernel/KernelAbi.ts";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
import type { MachineWorkspace } from "../MachineWorkspace.ts";

export const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
export const LARGE_FILE_COUNT = 65_000;
const SQLITE_VALUE_GUARD_BYTES = 2 * 1024 * 1024;
const clock = () => 1_800_000_000_000_000_001n;
const textEncoder = new TextEncoder();

export interface CapturedFile {
  readonly inode: string;
  readonly paths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly stat: null | {
    readonly type: string;
    readonly size: string;
    readonly nlink: string;
    readonly atimeNs: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
  readonly symlinkTarget: string | null;
  readonly posix: { readonly mode: number; readonly uid: number; readonly gid: number } | null;
  readonly content: readonly number[];
}

export interface CapturedCommit {
  readonly at: ForkCommit;
  readonly turnId: string;
  readonly files: readonly CapturedFile[];
}

interface LiveWorkspace {
  readonly wakes: KernelWakeRegistry;
  readonly persistence: ReturnType<typeof createFacetFilePersistence>;
  readonly filesystem: KernelFileSystem;
  workspace?: MachineWorkspace;
}

function boundValueBytes(value: string | number | null | ArrayBuffer): number {
  if (typeof value === "string") return textEncoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return typeof value === "number" ? 8 : 0;
}

function sqliteStorage(database: NodeSqlite.DatabaseSync, boundSqlValueBytes: number[]) {
  let transactionDepth = 0;
  let failNextStateUpdate = false;
  let stateUpdateFaultCount = 0;
  const storage: FacetStorage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        for (const value of bindings) {
          const bytes = boundValueBytes(value);
          boundSqlValueBytes.push(bytes);
          if (bytes > SQLITE_VALUE_GUARD_BYTES) {
            throw new Error(`SQLITE_TOOBIG: bound value is ${bytes} bytes`);
          }
        }
        const statement = database.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        const result = statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
        if (failNextStateUpdate && /^\s*UPDATE\s+kernel_fs_workspace_state\b/i.test(query)) {
          failNextStateUpdate = false;
          stateUpdateFaultCount += 1;
          throw new Error("injected failure after workspace state update");
        }
        return result;
      },
    },
    transactionSync(callback) {
      const savepoint = `large_journal_test_${transactionDepth++}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = callback();
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
  };
  return {
    storage,
    failAfterStateUpdate() {
      failNextStateUpdate = true;
    },
    get stateUpdateFaultCount() {
      return stateUpdateFaultCount;
    },
  };
}

export function largeJournalRig() {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  const boundSqlValueBytes: number[] = [];
  const guarded = sqliteStorage(sqlite, boundSqlValueBytes);
  const hydrationFiles = new Map<string, Uint8Array>();
  const hydration: FileHydrationPort = {
    async fetch({ paths, signal }) {
      if (signal.aborted) {
        return { status: "error", error: { code: "CANCELLED", message: "cancelled" } };
      }
      const files = paths.map((path) => ({ path, bytes: hydrationFiles.get(path) }));
      if (files.some((file) => file.bytes === undefined)) {
        return { status: "error", error: { code: "NOT_FOUND", message: "Fixture file missing" } };
      }
      return {
        status: "ok",
        value: files.map(({ path, bytes }) => ({
          path,
          chunks: (async function* () {
            yield bytes!;
          })(),
        })),
      };
    },
  };
  const commitCalls: CapturedCommit[] = [];
  const receipts = new Map<string, string>();
  let nextCommit = 1;
  const commits: FileCommitPort = {
    async commit(input) {
      const files: CapturedFile[] = [];
      for (const change of input.changedInodes) {
        const content: number[] = [];
        for await (const chunk of change.readChunks()) {
          for (const byte of chunk) content.push(byte);
        }
        const stat = change.stat;
        files.push({
          inode: change.inode.toString(),
          paths: [...change.paths],
          removedPaths: [...change.removedPaths],
          stat: stat
            ? {
                type: stat.type,
                size: stat.size.toString(),
                nlink: stat.nlink.toString(),
                atimeNs: stat.atimeNs.toString(),
                mtimeNs: stat.mtimeNs.toString(),
                ctimeNs: stat.ctimeNs.toString(),
              }
            : null,
          symlinkTarget: change.symlinkTarget,
          posix: change.posix ? { ...change.posix } : null,
          content,
        });
      }
      commitCalls.push({ at: { ...input.at }, turnId: input.turnId, files });
      const key = JSON.stringify([
        input.at.repository,
        input.at.fork,
        input.at.commit,
        input.turnId,
      ]);
      let commit = receipts.get(key);
      if (!commit) {
        commit = `remote-${nextCommit++}`;
        receipts.set(key, commit);
      }
      return { status: "ok", value: { commit } };
    },
  };
  const ports: FilePersistencePorts = { hydration, commits };
  const newLiveWorkspace = (): LiveWorkspace => {
    const wakes = new KernelWakeRegistry();
    const persistence = createFacetFilePersistence(guarded.storage, clock, { wakes, ports });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: persistence.storage }],
      cwd: "/",
    });
    return { wakes, persistence, filesystem };
  };
  const dispose = (live: LiveWorkspace) => {
    live.filesystem.dispose();
    live.persistence.dispose();
    live.wakes.dispose();
  };
  let live = newLiveWorkspace();
  const attachWorkspace = (
    initial: ForkCommit,
  ): LiveWorkspace & { workspace: MachineWorkspace } => {
    live.workspace = createFacetWorkspace({
      database: guarded.storage,
      persistence: live.persistence,
      filesystem: live.filesystem,
      mountPath: "/",
      initial,
      mount: async () => {
        throw new Error("The external machine mount is outside this adapter test");
      },
    });
    return live as LiveWorkspace & { workspace: MachineWorkspace };
  };

  return {
    storage: guarded.storage,
    boundSqlValueBytes,
    commitCalls,
    hydration,
    start(initial: ForkCommit = base) {
      return attachWorkspace(initial);
    },
    restart(initial: ForkCommit) {
      dispose(live);
      live = newLiveWorkspace();
      return attachWorkspace(initial);
    },
    setHydratedFile(path: string, bytes: Uint8Array) {
      hydrationFiles.set(path, bytes.slice());
    },
    seedLargeFlatTree() {
      if (live.workspace) throw new Error("Seed the tree before opening its workspace");
      const sequence = `WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LARGE_FILE_COUNT}
      )`;
      guarded.storage.sql.exec(`${sequence}
        INSERT INTO kernel_fs_inode (ino, type, size, nlink, atime_ns, mtime_ns, ctime_ns, target)
        SELECT printf('7%031d', i), 'file', '0', 1, '100', '101', '102', NULL FROM n
      `);
      guarded.storage.sql.exec(`${sequence}
        INSERT INTO kernel_fs_entry (parent, name, ino)
        SELECT '1', printf('file-%05d.txt', i), printf('7%031d', i) FROM n
      `);
      guarded.storage.sql.exec(`${sequence}
        INSERT INTO kernel_fs_posix (ino, mode, uid, gid)
        SELECT printf('7%031d', i), 420, 1000, 1000 FROM n
      `);
      guarded.storage.sql.exec("UPDATE kernel_fs_meta SET v = ? WHERE k = 'next_inode'", "100000");
    },
    changeLargeFileMetadata() {
      guarded.storage.sql.exec(`UPDATE kernel_fs_inode
        SET ctime_ns = CAST(CAST(ctime_ns AS INTEGER) + 1 AS TEXT)
        WHERE type = 'file' AND ino LIKE '7%'
      `);
    },
    failAfterStateUpdate() {
      guarded.failAfterStateUpdate();
    },
    get stateUpdateFaultCount() {
      return guarded.stateUpdateFaultCount;
    },
    close() {
      dispose(live);
      sqlite.close();
    },
  };
}

export const fixtureClock = clock;
