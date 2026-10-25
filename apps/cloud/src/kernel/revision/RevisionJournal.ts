import type { ForkCommit } from "../FilePersistencePorts.ts";
import type { FacetStorage } from "../FacetSqliteStorage.ts";
import { KernelRevisionWorkspaceError } from "./RevisionErrors.ts";
import { decodeManifest } from "./RevisionTree.ts";
import {
  deleteAttemptValues,
  installJournalValues,
  readAttemptValues,
  readStateManifest,
  writeAttemptValues,
  writeStateManifest,
} from "../KernelRevisionJournalStorage.ts";
import type { CheckpointAttempt, DirtyInode, WorkspaceState } from "./RevisionTypes.ts";

function firstRow(rows: Iterable<Record<string, unknown>>): Record<string, unknown> | undefined {
  const result = rows[Symbol.iterator]().next();
  return result.done ? undefined : result.value;
}

function invalidJournalData(): never {
  throw new KernelRevisionWorkspaceError("EIO", "The facet workspace journal is invalid");
}

export function installWorkspaceJournal(database: FacetStorage): void {
  database.transactionSync(() => {
    installJournalValues(database);
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), repository TEXT NOT NULL, fork_name TEXT NOT NULL, commit_id TEXT NOT NULL, manifest_json TEXT NOT NULL, epoch INTEGER NOT NULL, baseline_epoch INTEGER NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_dirty_inode (ino TEXT PRIMARY KEY, version INTEGER NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_checkpoint (operation_id TEXT PRIMARY KEY, repository TEXT NOT NULL, fork_name TEXT NOT NULL, base_commit TEXT NOT NULL, commit_id TEXT NOT NULL, epoch INTEGER NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_attempt (operation_id TEXT PRIMARY KEY, repository TEXT NOT NULL, fork_name TEXT NOT NULL, base_commit TEXT NOT NULL, manifest_json TEXT NOT NULL, epoch INTEGER NOT NULL, changed_json TEXT NOT NULL, dirty_json TEXT NOT NULL)",
    );
    database.sql.exec(
      "CREATE TABLE IF NOT EXISTS kernel_fs_workspace_apply_chunk (apply_id TEXT NOT NULL, remote_ino TEXT NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, PRIMARY KEY (apply_id, remote_ino, part))",
    );
    // The storage port has no mutation feed, so triggers keep the apply-time CAS exact.
    const mark = (value: string) =>
      `INSERT INTO kernel_fs_workspace_dirty_inode (ino, version) VALUES (${value}, 1) ON CONFLICT(ino) DO UPDATE SET version = version + 1;`;
    const bump = "UPDATE kernel_fs_workspace_state SET epoch = epoch + 1 WHERE singleton = 1;";
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_inode_insert AFTER INSERT ON kernel_fs_inode BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_inode_update AFTER UPDATE ON kernel_fs_inode BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_inode_delete AFTER DELETE ON kernel_fs_inode BEGIN ${mark("OLD.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_entry_insert AFTER INSERT ON kernel_fs_entry BEGIN ${mark("NEW.ino")} ${mark("NEW.parent")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_entry_delete AFTER DELETE ON kernel_fs_entry BEGIN ${mark("OLD.ino")} ${mark("OLD.parent")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_posix_insert AFTER INSERT ON kernel_fs_posix BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_posix_update AFTER UPDATE ON kernel_fs_posix BEGIN ${mark("NEW.ino")} ${bump} END`,
    );
    database.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS kernel_fs_workspace_posix_delete AFTER DELETE ON kernel_fs_posix BEGIN ${mark("OLD.ino")} ${bump} END`,
    );
  });
}

export function readState(database: FacetStorage): WorkspaceState {
  const row = firstRow(
    database.sql.exec(
      "SELECT repository, fork_name, commit_id, manifest_json, baseline_epoch FROM kernel_fs_workspace_state WHERE singleton = 1",
    ),
  );
  if (!row)
    throw new KernelRevisionWorkspaceError("EIO", "The facet workspace revision is missing");
  const manifestJson = readStateManifest(database, row.manifest_json);
  const epoch = Number(row.baseline_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return invalidJournalData();
  return {
    at: {
      repository: String(row.repository),
      fork: String(row.fork_name),
      commit: String(row.commit_id),
    },
    manifest: decodeManifest(manifestJson),
    epoch,
  };
}

export function readEpoch(database: FacetStorage): number {
  const row = firstRow(
    database.sql.exec("SELECT epoch FROM kernel_fs_workspace_state WHERE singleton = 1"),
  );
  if (!row)
    throw new KernelRevisionWorkspaceError("EIO", "The facet workspace revision is missing");
  const epoch = Number(row.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return invalidJournalData();
  return epoch;
}

export function readDirty(database: FacetStorage): DirtyInode[] {
  return Array.from(
    database.sql.exec("SELECT ino, version FROM kernel_fs_workspace_dirty_inode ORDER BY ino"),
    (row) => {
      const version = Number(row.version);
      if (!/^[1-9][0-9]*$/.test(String(row.ino)) || !Number.isSafeInteger(version) || version < 0)
        return invalidJournalData();
      return { inode: String(row.ino), version };
    },
  );
}

export function restoreDirtySnapshot(database: FacetStorage, dirty: readonly DirtyInode[]): void {
  database.sql.exec("DELETE FROM kernel_fs_workspace_dirty_inode");
  for (const entry of dirty) {
    database.sql.exec(
      "INSERT INTO kernel_fs_workspace_dirty_inode (ino, version) VALUES (?, ?)",
      entry.inode,
      entry.version,
    );
  }
}

export function readAttempt(
  database: FacetStorage,
  operationId: string,
): CheckpointAttempt | undefined {
  const row = firstRow(
    database.sql.exec(
      "SELECT * FROM kernel_fs_workspace_attempt WHERE operation_id = ?",
      operationId,
    ),
  );
  if (!row) return undefined;
  const values = readAttemptValues(database, operationId, row);
  const manifest = values.manifest;
  const epoch = Number(row.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return invalidJournalData();
  decodeManifest(manifest);
  return {
    at: {
      repository: String(row.repository),
      fork: String(row.fork_name),
      commit: String(row.base_commit),
    },
    manifest,
    epoch,
    changed: values.changed,
    dirty: values.dirty,
  };
}

export function checkpointReceiptWithBase(database: FacetStorage, operationId: string) {
  return firstRow(
    database.sql.exec(
      "SELECT repository, fork_name, base_commit, commit_id FROM kernel_fs_workspace_checkpoint WHERE operation_id = ?",
      operationId,
    ),
  );
}

export function hasWorkspaceState(database: FacetStorage): boolean {
  return Boolean(
    firstRow(
      database.sql.exec("SELECT singleton FROM kernel_fs_workspace_state WHERE singleton = 1"),
    ),
  );
}

export function ensureWorkspaceState(
  database: FacetStorage,
  input: { readonly at: ForkCommit; readonly manifestJson: string },
): void {
  database.transactionSync(() => {
    if (hasWorkspaceState(database)) return;
    database.sql.exec(
      "INSERT OR IGNORE INTO kernel_fs_workspace_state (singleton, repository, fork_name, commit_id, manifest_json, epoch, baseline_epoch) VALUES (1, ?, ?, ?, ?, 0, 0)",
      input.at.repository,
      input.at.fork,
      input.at.commit,
      writeStateManifest(database, input.manifestJson),
    );
    database.sql.exec("DELETE FROM kernel_fs_workspace_dirty_inode");
  });
}

export function insertCheckpointAttempt(
  database: FacetStorage,
  operationId: string,
  attempt: CheckpointAttempt,
): void {
  database.transactionSync(() => {
    const still = readState(database);
    if (
      still.at.repository !== attempt.at.repository ||
      still.at.fork !== attempt.at.fork ||
      still.at.commit !== attempt.at.commit
    ) {
      throw new KernelRevisionWorkspaceError(
        "ESTALE",
        "The facet revision advanced during checkpoint",
      );
    }
    if (readAttempt(database, operationId)) return;
    const values = writeAttemptValues(database, operationId, {
      manifest: attempt.manifest,
      changed: attempt.changed,
      dirty: attempt.dirty,
    });
    database.sql.exec(
      "INSERT OR IGNORE INTO kernel_fs_workspace_attempt (operation_id, repository, fork_name, base_commit, manifest_json, epoch, changed_json, dirty_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      operationId,
      attempt.at.repository,
      attempt.at.fork,
      attempt.at.commit,
      values.manifest,
      attempt.epoch,
      values.changed,
      values.dirty,
    );
  });
}

export function recordCheckpoint(
  database: FacetStorage,
  operationId: string,
  attempt: CheckpointAttempt,
  commit: string,
): ForkCommit {
  const after = { ...attempt.at, commit };
  return database.transactionSync(() => {
    const alreadyCompleted = checkpointReceiptWithBase(database, operationId);
    if (alreadyCompleted) {
      if (
        alreadyCompleted.repository !== attempt.at.repository ||
        alreadyCompleted.fork_name !== attempt.at.fork ||
        alreadyCompleted.base_commit !== attempt.at.commit
      ) {
        throw new KernelRevisionWorkspaceError("EINVAL", "The checkpoint operation id was reused");
      }
      return {
        repository: String(alreadyCompleted.repository),
        fork: String(alreadyCompleted.fork_name),
        commit: String(alreadyCompleted.commit_id),
      };
    }
    const current = readState(database);
    if (
      current.at.repository !== attempt.at.repository ||
      current.at.fork !== attempt.at.fork ||
      current.at.commit !== attempt.at.commit
    ) {
      throw new KernelRevisionWorkspaceError(
        "ESTALE",
        "The facet revision advanced during checkpoint",
      );
    }
    database.sql.exec(
      "UPDATE kernel_fs_workspace_state SET commit_id = ?, manifest_json = ?, baseline_epoch = ? WHERE singleton = 1",
      after.commit,
      writeStateManifest(database, attempt.manifest),
      attempt.epoch,
    );
    for (const dirty of attempt.dirty) {
      database.sql.exec(
        "DELETE FROM kernel_fs_workspace_dirty_inode WHERE ino = ? AND version = ?",
        dirty.inode,
        dirty.version,
      );
    }
    database.sql.exec(
      "INSERT INTO kernel_fs_workspace_checkpoint VALUES (?, ?, ?, ?, ?, ?)",
      operationId,
      attempt.at.repository,
      attempt.at.fork,
      attempt.at.commit,
      after.commit,
      attempt.epoch,
    );
    const obsolete = [
      ...database.sql.exec(
        "SELECT operation_id FROM kernel_fs_workspace_attempt WHERE operation_id = ? OR (repository = ? AND fork_name = ? AND base_commit <> ?)",
        operationId,
        attempt.at.repository,
        attempt.at.fork,
        after.commit,
      ),
    ];
    for (const row of obsolete) {
      deleteAttemptValues(database, String(row.operation_id));
      database.sql.exec(
        "DELETE FROM kernel_fs_workspace_attempt WHERE operation_id = ?",
        String(row.operation_id),
      );
    }
    return after;
  });
}

export function deleteStaleAttempt(
  database: FacetStorage,
  operationId: string,
  staleBase: ForkCommit,
): void {
  database.transactionSync(() => {
    const current = readAttempt(database, operationId);
    if (
      current &&
      current.at.repository === staleBase.repository &&
      current.at.fork === staleBase.fork &&
      current.at.commit === staleBase.commit
    ) {
      deleteAttemptValues(database, operationId);
      database.sql.exec(
        "DELETE FROM kernel_fs_workspace_attempt WHERE operation_id = ?",
        operationId,
      );
    }
  });
}
