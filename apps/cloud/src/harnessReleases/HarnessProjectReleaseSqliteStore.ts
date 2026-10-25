import { HarnessReleaseLedgerError } from "./internal/records.ts";
import type {
  HarnessProvider,
  HarnessReleaseArtifact,
  HarnessReleaseLedgerStore,
  HarnessReleaseLedgerTransaction,
  HarnessReleaseProof,
  HarnessReleaseSelection,
  HarnessReleaseSelectionEvent,
} from "./internal/types.ts";
import type { HarnessReleaseSqliteDatabase } from "./HarnessReleaseSqliteStore.ts";

type RecordKind = "artifact" | "proof" | "selection" | "event";

const first = (rows: Iterable<Record<string, unknown>>) => {
  for (const row of rows) return row;
  return undefined;
};

const decode = <A>(row: Record<string, unknown> | undefined): A | null => {
  if (row === undefined) return null;
  if (typeof row.record_json !== "string") throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  try {
    return JSON.parse(row.record_json) as A;
  } catch {
    throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  }
};

class ProjectTransaction implements HarnessReleaseLedgerTransaction {
  private readonly database: HarnessReleaseSqliteDatabase;
  private readonly projectId: string;

  constructor(database: HarnessReleaseSqliteDatabase, projectId: string) {
    this.database = database;
    this.projectId = projectId;
  }

  private read<A>(kind: RecordKind, key: string) {
    return decode<A>(
      first(
        this.database.sql.exec(
          `SELECT record_json FROM harness_project_release_records
            WHERE project_id = ? AND kind = ? AND record_key = ?`,
          this.projectId,
          kind,
          key,
        ),
      ),
    );
  }

  private insert(
    kind: RecordKind,
    key: string,
    provider: HarnessProvider,
    releaseId: string | null,
    record: unknown,
    revision: number | null = null,
    action: string | null = null,
  ) {
    this.database.sql.exec(
      `INSERT INTO harness_project_release_records
        (project_id, kind, record_key, provider, release_id, revision, action, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.projectId,
      kind,
      key,
      provider,
      releaseId,
      revision,
      action,
      JSON.stringify(record),
    );
  }

  getArtifact(provider: HarnessProvider, releaseId: string) {
    return this.read<HarnessReleaseArtifact>("artifact", JSON.stringify([provider, releaseId]));
  }

  insertArtifact(artifact: HarnessReleaseArtifact) {
    this.insert(
      "artifact",
      JSON.stringify([artifact.provider, artifact.releaseId]),
      artifact.provider,
      artifact.releaseId,
      artifact,
    );
  }

  getProof(proofId: string) {
    return this.read<HarnessReleaseProof>("proof", proofId);
  }

  appendProof(proof: HarnessReleaseProof) {
    this.insert("proof", proof.proofId, proof.provider, proof.releaseId, proof);
  }

  listProofs(provider: HarnessProvider, releaseId: string) {
    return [
      ...this.database.sql.exec(
        `SELECT record_json FROM harness_project_release_records
          WHERE project_id = ? AND kind = 'proof' AND provider = ? AND release_id = ?
          ORDER BY sequence ASC`,
        this.projectId,
        provider,
        releaseId,
      ),
    ].map((row) => decode<HarnessReleaseProof>(row) as HarnessReleaseProof);
  }

  getSelection(provider: HarnessProvider): HarnessReleaseSelection {
    return (
      this.read<HarnessReleaseSelection>("selection", provider) ?? {
        provider,
        revision: 0,
        currentReleaseId: null,
        lastGreenReleaseId: null,
        action: null,
        changedAt: null,
      }
    );
  }

  compareAndSwapSelection(
    provider: HarnessProvider,
    expectedRevision: number,
    next: HarnessReleaseSelection,
  ) {
    this.database.sql.exec(
      `INSERT INTO harness_project_release_records
        (project_id, kind, record_key, provider, revision, record_json)
        VALUES (?, 'selection', ?, ?, 0, ?)
        ON CONFLICT(project_id, kind, record_key) DO NOTHING`,
      this.projectId,
      provider,
      provider,
      JSON.stringify(this.getSelection(provider)),
    );
    const updated = first(
      this.database.sql.exec(
        `UPDATE harness_project_release_records
            SET revision = ?, release_id = ?, action = ?, record_json = ?
            WHERE project_id = ? AND kind = 'selection' AND record_key = ? AND revision = ?
            RETURNING revision`,
        next.revision,
        next.currentReleaseId,
        next.action,
        JSON.stringify(next),
        this.projectId,
        provider,
        expectedRevision,
      ),
    );
    return updated !== undefined && Number(updated.revision) === next.revision;
  }

  appendSelectionEvent(event: HarnessReleaseSelectionEvent) {
    this.insert(
      "event",
      JSON.stringify([event.provider, event.revision]),
      event.provider,
      event.toReleaseId,
      event,
      event.revision,
      event.action,
    );
  }

  listSelectionEvents(provider: HarnessProvider) {
    return [
      ...this.database.sql.exec(
        `SELECT record_json FROM harness_project_release_records
          WHERE project_id = ? AND kind = 'event' AND provider = ? ORDER BY revision ASC`,
        this.projectId,
        provider,
      ),
    ].map((row) => decode<HarnessReleaseSelectionEvent>(row) as HarnessReleaseSelectionEvent);
  }

  wasEverGreen(provider: HarnessProvider, releaseId: string) {
    return (
      first(
        this.database.sql.exec(
          `SELECT 1 AS present FROM harness_project_release_records
            WHERE project_id = ? AND kind = 'event' AND provider = ?
              AND release_id = ? AND action = 'green' LIMIT 1`,
          this.projectId,
          provider,
          releaseId,
        ),
      ) !== undefined
    );
  }
}

/** A UserObject holds several projects. Their release history and CAS revisions cannot overlap. */
export const createHarnessProjectReleaseSqliteStore = (
  database: HarnessReleaseSqliteDatabase,
  projectId: string,
): HarnessReleaseLedgerStore => {
  if (!projectId.trim()) throw new HarnessReleaseLedgerError("INVALID_RECORD");
  database.sql.exec(`CREATE TABLE IF NOT EXISTS harness_project_release_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    release_id TEXT,
    revision INTEGER,
    action TEXT,
    record_json TEXT NOT NULL,
    UNIQUE (project_id, kind, record_key)
  )`);
  database.sql.exec(`CREATE INDEX IF NOT EXISTS harness_project_release_history
    ON harness_project_release_records (project_id, kind, provider, release_id, sequence)`);
  return {
    transaction: (operation) =>
      database.transactionSync(() => operation(new ProjectTransaction(database, projectId))),
  };
};
