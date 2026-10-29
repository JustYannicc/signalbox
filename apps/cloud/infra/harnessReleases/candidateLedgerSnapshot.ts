import * as NodeSqlite from "node:sqlite";
import {
  createHarnessReleaseLedger,
  type HarnessReleaseArtifact,
  type HarnessReleaseEligibility,
} from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import { createHarnessProjectReleaseSqliteStore } from "../../src/harnessReleases/HarnessProjectReleaseSqliteStore.ts";
import {
  createHarnessReleaseSqliteStore,
  type HarnessReleaseSqliteDatabase,
} from "../../src/harnessReleases/HarnessReleaseSqliteStore.ts";

const createStorage = (database: NodeSqlite.DatabaseSync): HarnessReleaseSqliteDatabase => ({
  sql: {
    exec(query, ...bindings) {
      const statement = database.prepare(query);
      return statement.columns().length > 0
        ? statement.all(...bindings)
        : (statement.run(...bindings), []);
    },
  },
  transactionSync(operation) {
    database.exec("BEGIN");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  },
});

const ledgerFor = (database: NodeSqlite.DatabaseSync, projectId?: string) => {
  const storage = createStorage(database);
  return createHarnessReleaseLedger(
    projectId === undefined
      ? createHarnessReleaseSqliteStore(storage)
      : createHarnessProjectReleaseSqliteStore(storage, projectId),
  );
};

/** Creates a new snapshot with only the candidate artifacts and no qualification proofs. */
export const writeCandidateLedgerSnapshot = (
  path: string,
  projectId: string | undefined,
  artifacts: readonly HarnessReleaseArtifact[],
) => {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    const ledger = ledgerFor(database, projectId);
    for (const artifact of artifacts) ledger.registerArtifact(artifact);
  } finally {
    database.close();
  }
};

/** Reopens the snapshot read-only and proves the records remain pending and unselected. */
export const verifyCandidateLedgerSnapshot = (
  path: string,
  projectId: string | undefined,
  expectedArtifacts: readonly HarnessReleaseArtifact[],
): ReadonlyArray<HarnessReleaseEligibility> => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const ledger = ledgerFor(database, projectId);
    const eligibility: HarnessReleaseEligibility[] = [];
    const fields = [
      "provider",
      "releaseId",
      "artifactHash",
      "artifactRef",
      "sourceIdentity",
      "fixtureIdentity",
      "createdAt",
    ] as const;
    for (const expected of expectedArtifacts) {
      const stored = ledger.getArtifact(expected.provider, expected.releaseId);
      if (stored === null) throw new Error("HARNESS_CANDIDATE_LEDGER_ROW_MISMATCH");
      if (fields.some((field) => stored[field] !== expected[field]))
        throw new Error("HARNESS_CANDIDATE_LEDGER_ROW_MISMATCH");
      if (ledger.listProofs(expected.provider, expected.releaseId).length !== 0)
        throw new Error("HARNESS_CANDIDATE_UNVERIFIED_PROOF_PRESENT");
      const result = ledger.getEligibility(expected.provider, expected.releaseId);
      if (result.status !== "pending")
        throw new Error("HARNESS_CANDIDATE_QUALIFICATION_NOT_PENDING");
      eligibility.push(result);
    }
    const selection = ledger.getSelection("claude-code");
    if (
      selection.revision !== 0 ||
      selection.currentReleaseId !== null ||
      selection.lastGreenReleaseId !== null ||
      selection.action !== null
    )
      throw new Error("HARNESS_CANDIDATE_SELECTION_CHANGED");
    return eligibility;
  } finally {
    database.close();
  }
};
