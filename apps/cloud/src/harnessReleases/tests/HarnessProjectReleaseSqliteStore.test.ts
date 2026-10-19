import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessReleaseLedger,
  type HarnessReleaseArtifact,
  type HarnessReleaseProof,
} from "../HarnessReleaseLedger.ts";
import { createHarnessProjectReleaseSqliteStore } from "../HarnessProjectReleaseSqliteStore.ts";
import {
  createHarnessReleaseSqliteStore,
  type HarnessReleaseSqliteDatabase,
} from "../HarnessReleaseSqliteStore.ts";

const fixture = () => {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  const storage: HarnessReleaseSqliteDatabase = {
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        return statement.columns().length > 0
          ? statement.all(...bindings)
          : (statement.run(...bindings), []);
      },
    },
    transactionSync(callback) {
      database.exec("BEGIN");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  const project = (projectId: string) =>
    createHarnessReleaseLedger(createHarnessProjectReleaseSqliteStore(storage, projectId));
  return { database, storage, project };
};

const artifact = (hash: string, releaseId = "r1"): HarnessReleaseArtifact => ({
  provider: "codex",
  releaseId,
  artifactHash: hash,
  artifactRef: "artifact://release",
  sourceIdentity: "source",
  fixtureIdentity: "fixture",
  createdAt: "2026-10-19T00:00:00.000Z",
});

const proof = (
  release: HarnessReleaseArtifact,
  environment: HarnessReleaseProof["environment"],
): HarnessReleaseProof => ({
  ...release,
  proofId: `${release.releaseId}-${environment}`,
  environment,
  recordedAt: release.createdAt,
  checks: {
    unchangedSource: "passed",
    boot: "passed",
    toolTurn: "passed",
    resume: "passed",
    mcp: "passed",
    interrupt: "passed",
  },
  metrics: {
    bootTimeMs: { state: "measured", value: 10 },
    moduleBytes: { state: "measured", value: 100 },
    peakHeapBytes: { state: "measured", value: 1000 },
  },
});

const record = (
  ledger: ReturnType<typeof createHarnessReleaseLedger>,
  hash: string,
  releaseId = "r1",
) => {
  const release = ledger.registerArtifact(artifact(hash, releaseId));
  ledger.recordProof(proof(release, "local-workerd"));
  ledger.recordProof(proof(release, "deployed-do"));
  return release;
};

const select = (
  ledger: ReturnType<typeof createHarnessReleaseLedger>,
  expectedRevision = 0,
  releaseId = "r1",
) =>
  ledger.compareAndSwapLastGreen({
    provider: "codex",
    releaseId,
    expectedRevision,
    changedAt: "2026-10-19T01:00:00.000Z",
  });

describe("project release storage", () => {
  it("isolates identical artifact, proof and selection keys across projects and the legacy store", () => {
    const f = fixture();
    try {
      const alpha = f.project("alpha");
      const alphaPeer = f.project("alpha");
      const beta = f.project("beta");
      const legacy = createHarnessReleaseLedger(createHarnessReleaseSqliteStore(f.storage));
      record(alpha, "alpha-bytes");
      record(beta, "beta-bytes");
      record(legacy, "legacy-bytes");
      expect(select(alpha).status).toBe("selected");
      expect(select(alphaPeer).status).toBe("conflict");
      expect(beta.getSelection("codex").revision).toBe(0);
      expect(legacy.getSelection("codex").revision).toBe(0);
      expect(select(beta).status).toBe("selected");
      expect(select(alpha).status).toBe("conflict");
      const alphaAgain = f.project("alpha");
      expect(alphaAgain.resolveCurrent("codex")?.artifactHash).toBe("alpha-bytes");
      expect(beta.resolveCurrent("codex")?.artifactHash).toBe("beta-bytes");
      expect(legacy.getArtifact("codex", "r1")?.artifactHash).toBe("legacy-bytes");
      expect(alphaAgain.listProofs("codex", "r1")).toHaveLength(2);
      expect(alphaAgain.listSelectionEvents("codex")).toHaveLength(1);
      expect(f.project("alpha\u0000beta").getArtifact("codex", "r1")).toBeNull();
    } finally {
      f.database.close();
    }
  });

  it("keeps later rejected proof and historical pinback authority inside their project", () => {
    const f = fixture();
    try {
      const alpha = f.project("alpha");
      const beta = f.project("beta");
      const release = record(alpha, "same-bytes");
      beta.registerArtifact(artifact("same-bytes"));
      expect(
        beta.pinBack({
          provider: "codex",
          releaseId: "r1",
          expectedRevision: 0,
          changedAt: "2026-10-19T02:00:00.000Z",
          reason: "restore the proven release",
        }).status,
      ).toBe("never-green");
      record(beta, "same-bytes");
      record(beta, "beta-r2-bytes", "r2");
      select(alpha);
      alpha.recordProof({
        ...proof(release, "deployed-do"),
        proofId: "later-red",
        checks: { ...proof(release, "deployed-do").checks, resume: "rejected" },
      });
      expect(alpha.getEligibility("codex", "r1").status).toBe("rejected");
      expect(beta.getEligibility("codex", "r1").status).toBe("green");
      expect(select(beta).status).toBe("selected");
      expect(select(beta, 1, "r2").status).toBe("selected");
      expect(
        beta.pinBack({
          provider: "codex",
          releaseId: "r1",
          expectedRevision: 2,
          changedAt: "2026-10-19T02:00:00.000Z",
          reason: "restore the proven release",
        }).status,
      ).toBe("selected");
      expect(beta.getSelection("codex")).toMatchObject({
        revision: 3,
        currentReleaseId: "r1",
        lastGreenReleaseId: "r2",
        action: "pinback",
      });
      expect(alpha.listSelectionEvents("codex").map((event) => event.action)).toEqual(["green"]);
      expect(beta.listSelectionEvents("codex").map((event) => event.action)).toEqual([
        "green",
        "green",
        "pinback",
      ]);
    } finally {
      f.database.close();
    }
  });

  it("rolls back selection and event together when the event write fails", () => {
    const f = fixture();
    try {
      const alpha = f.project("alpha");
      record(alpha, "bytes");
      f.database.exec(`CREATE TRIGGER refuse_release_event BEFORE INSERT
        ON harness_project_release_records WHEN NEW.kind = 'event'
        BEGIN SELECT RAISE(ABORT, 'event write failed'); END`);
      expect(() => select(alpha)).toThrow("event write failed");
      expect(alpha.getSelection("codex").revision).toBe(0);
      expect(alpha.listSelectionEvents("codex")).toEqual([]);
      f.database.exec("DROP TRIGGER refuse_release_event");
      expect(select(alpha).status).toBe("selected");
    } finally {
      f.database.close();
    }
  });
});
