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

type SqlBinding = string | number | null;

export interface HarnessReleaseSqliteDatabase {
  readonly sql: {
    exec(query: string, ...bindings: SqlBinding[]): Iterable<Record<string, unknown>>;
  };
  transactionSync<T>(callback: () => T): T;
}

const emptySelection = (provider: HarnessProvider): HarnessReleaseSelection => ({
  provider,
  revision: 0,
  currentReleaseId: null,
  lastGreenReleaseId: null,
  action: null,
  changedAt: null,
});

const parseRecord = <A>(row: Record<string, unknown> | undefined): A | null => {
  if (row === undefined) return null;
  if (typeof row.record_json !== "string") throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  try {
    return JSON.parse(row.record_json) as A;
  } catch {
    throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  }
};

const first = (rows: Iterable<Record<string, unknown>>) => rows[Symbol.iterator]().next().value;

const selectionFromRow = (provider: HarnessProvider, row: Record<string, unknown> | undefined) => {
  if (row === undefined) return emptySelection(provider);
  const revision = Number(row.revision);
  const currentReleaseId = row.current_release_id;
  const lastGreenReleaseId = row.last_green_release_id;
  const action = row.action;
  const changedAt = row.changed_at;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (currentReleaseId !== null && typeof currentReleaseId !== "string") ||
    (lastGreenReleaseId !== null && typeof lastGreenReleaseId !== "string") ||
    (action !== null && action !== "green" && action !== "pinback") ||
    (changedAt !== null && typeof changedAt !== "string")
  ) {
    throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
  }
  return {
    provider,
    revision,
    currentReleaseId,
    lastGreenReleaseId,
    action,
    changedAt,
  } as HarnessReleaseSelection;
};

class SqliteTransaction implements HarnessReleaseLedgerTransaction {
  private readonly database: HarnessReleaseSqliteDatabase;

  constructor(database: HarnessReleaseSqliteDatabase) {
    this.database = database;
  }

  getArtifact(provider: HarnessProvider, releaseId: string) {
    return parseRecord<HarnessReleaseArtifact>(
      first(
        this.database.sql.exec(
          "SELECT record_json FROM harness_release_artifacts WHERE provider = ? AND release_id = ?",
          provider,
          releaseId,
        ),
      ),
    );
  }

  insertArtifact(artifact: HarnessReleaseArtifact) {
    this.database.sql.exec(
      "INSERT INTO harness_release_artifacts (provider, release_id, record_json) VALUES (?, ?, ?)",
      artifact.provider,
      artifact.releaseId,
      JSON.stringify(artifact),
    );
  }

  getProof(proofId: string) {
    return parseRecord<HarnessReleaseProof>(
      first(
        this.database.sql.exec(
          "SELECT record_json FROM harness_release_proofs WHERE proof_id = ?",
          proofId,
        ),
      ),
    );
  }

  appendProof(proof: HarnessReleaseProof) {
    this.database.sql.exec(
      `INSERT INTO harness_release_proofs
        (proof_id, provider, release_id, environment, record_json) VALUES (?, ?, ?, ?, ?)`,
      proof.proofId,
      proof.provider,
      proof.releaseId,
      proof.environment,
      JSON.stringify(proof),
    );
  }

  listProofs(provider: HarnessProvider, releaseId: string) {
    return [
      ...this.database.sql.exec(
        `SELECT record_json FROM harness_release_proofs
          WHERE provider = ? AND release_id = ? ORDER BY sequence ASC`,
        provider,
        releaseId,
      ),
    ].map((row) => parseRecord<HarnessReleaseProof>(row) as HarnessReleaseProof);
  }

  getSelection(provider: HarnessProvider) {
    return selectionFromRow(
      provider,
      first(
        this.database.sql.exec(
          `SELECT revision, current_release_id, last_green_release_id, action, changed_at
            FROM harness_release_selections WHERE provider = ?`,
          provider,
        ),
      ),
    );
  }

  compareAndSwapSelection(
    provider: HarnessProvider,
    expectedRevision: number,
    next: HarnessReleaseSelection,
  ) {
    this.database.sql.exec(
      `INSERT INTO harness_release_selections
        (provider, revision, current_release_id, last_green_release_id, action, changed_at)
        VALUES (?, 0, NULL, NULL, NULL, NULL) ON CONFLICT(provider) DO NOTHING`,
      provider,
    );
    const updated = first(
      this.database.sql.exec(
        `UPDATE harness_release_selections SET revision = ?, current_release_id = ?,
        last_green_release_id = ?, action = ?, changed_at = ?
        WHERE provider = ? AND revision = ? RETURNING revision`,
        next.revision,
        next.currentReleaseId,
        next.lastGreenReleaseId,
        next.action,
        next.changedAt,
        provider,
        expectedRevision,
      ),
    );
    return updated !== undefined && Number(updated.revision) === next.revision;
  }

  appendSelectionEvent(event: HarnessReleaseSelectionEvent) {
    this.database.sql.exec(
      `INSERT INTO harness_release_selection_events
        (provider, revision, action, to_release_id, record_json) VALUES (?, ?, ?, ?, ?)`,
      event.provider,
      event.revision,
      event.action,
      event.toReleaseId,
      JSON.stringify(event),
    );
  }

  listSelectionEvents(provider: HarnessProvider) {
    return [
      ...this.database.sql.exec(
        `SELECT record_json FROM harness_release_selection_events
          WHERE provider = ? ORDER BY revision ASC`,
        provider,
      ),
    ].map((row) => parseRecord<HarnessReleaseSelectionEvent>(row) as HarnessReleaseSelectionEvent);
  }

  wasEverGreen(provider: HarnessProvider, releaseId: string) {
    return (
      first(
        this.database.sql.exec(
          `SELECT 1 AS present FROM harness_release_selection_events
            WHERE provider = ? AND action = 'green' AND to_release_id = ? LIMIT 1`,
          provider,
          releaseId,
        ),
      ) !== undefined
    );
  }
}

export const createHarnessReleaseSqliteStore = (
  database: HarnessReleaseSqliteDatabase,
): HarnessReleaseLedgerStore => {
  database.sql.exec(`CREATE TABLE IF NOT EXISTS harness_release_artifacts (
    provider TEXT NOT NULL,
    release_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (provider, release_id)
  )`);
  database.sql.exec(`CREATE TABLE IF NOT EXISTS harness_release_proofs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    proof_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    release_id TEXT NOT NULL,
    environment TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`);
  database.sql.exec(`CREATE INDEX IF NOT EXISTS harness_release_proofs_latest
    ON harness_release_proofs (provider, release_id, environment, sequence)`);
  database.sql.exec(`CREATE TABLE IF NOT EXISTS harness_release_selections (
    provider TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    current_release_id TEXT,
    last_green_release_id TEXT,
    action TEXT,
    changed_at TEXT
  )`);
  database.sql.exec(`CREATE TABLE IF NOT EXISTS harness_release_selection_events (
    provider TEXT NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    to_release_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (provider, revision)
  )`);

  return {
    transaction: (operation) =>
      database.transactionSync(() => operation(new SqliteTransaction(database))),
  };
};
