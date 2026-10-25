import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessReleaseLedger,
  HARNESS_PROVIDERS,
  REQUIRED_HARNESS_CHECKS,
  type HarnessCheckResult,
  type HarnessMetric,
  type HarnessProofEnvironment,
  type HarnessProvider,
  type HarnessReleaseArtifact,
  type HarnessReleaseProof,
} from "../HarnessReleaseLedger.ts";
import {
  createHarnessReleaseSqliteStore,
  type HarnessReleaseSqliteDatabase,
} from "../HarnessReleaseSqliteStore.ts";

const createDatabase = (path = ":memory:") => {
  const database = new NodeSqlite.DatabaseSync(path);
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
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { database, store: createHarnessReleaseSqliteStore(storage) };
};

const artifact = (provider: HarnessProvider, releaseId: string): HarnessReleaseArtifact => ({
  provider,
  releaseId,
  artifactHash: `hash-${releaseId}`,
  artifactRef: `artifact://${releaseId}`,
  sourceIdentity: `source-${provider}-${releaseId}`,
  fixtureIdentity: `fixture-${provider}-${releaseId}`,
  createdAt: `2026-10-19T00:00:00.000Z`,
});

const checks = (
  overrides: Partial<Record<(typeof REQUIRED_HARNESS_CHECKS)[number], HarnessCheckResult>> = {},
) =>
  Object.fromEntries(
    REQUIRED_HARNESS_CHECKS.map((check) => [check, overrides[check] ?? "passed"]),
  ) as HarnessReleaseProof["checks"];

const measured = (value: number): HarnessMetric => ({ state: "measured", value });

const metrics = (peakHeapBytes: HarnessMetric = measured(4096)) => ({
  bootTimeMs: measured(120),
  moduleBytes: measured(8192),
  peakHeapBytes,
});

const proof = (
  release: HarnessReleaseArtifact,
  environment: HarnessProofEnvironment,
  proofId: string,
  options: {
    readonly checks?: HarnessReleaseProof["checks"];
    readonly metrics?: HarnessReleaseProof["metrics"];
  } = {},
): HarnessReleaseProof => ({
  proofId,
  provider: release.provider,
  releaseId: release.releaseId,
  artifactHash: release.artifactHash,
  sourceIdentity: release.sourceIdentity,
  fixtureIdentity: release.fixtureIdentity,
  environment,
  recordedAt: `2026-10-19T00:00:${proofId.length.toString().padStart(2, "0")}.000Z`,
  checks: options.checks ?? checks(),
  metrics: options.metrics ?? metrics(),
});

const recordGreenProofs = (
  ledger: ReturnType<typeof createHarnessReleaseLedger>,
  release: HarnessReleaseArtifact,
) => {
  ledger.recordProof(proof(release, "local-workerd", `${release.releaseId}-local`));
  ledger.recordProof(proof(release, "deployed-do", `${release.releaseId}-deployed`));
};

describe("harness release ledger", () => {
  it("rejects stale-revision green selections and records pinback", async () => {
    const fixture = createDatabase();
    try {
      const ledger = createHarnessReleaseLedger(fixture.store);
      const first = artifact("codex", "r1");
      const second = artifact("codex", "r2");
      ledger.registerArtifact(first);
      ledger.registerArtifact(second);
      recordGreenProofs(ledger, first);
      recordGreenProofs(ledger, second);

      const attempts = await Promise.all([
        Promise.resolve().then(() =>
          ledger.compareAndSwapLastGreen({
            provider: "codex",
            releaseId: first.releaseId,
            expectedRevision: 0,
            changedAt: "2026-10-19T01:00:00.000Z",
          }),
        ),
        Promise.resolve().then(() =>
          ledger.compareAndSwapLastGreen({
            provider: "codex",
            releaseId: second.releaseId,
            expectedRevision: 0,
            changedAt: "2026-10-19T01:00:01.000Z",
          }),
        ),
      ]);
      expect(attempts.map((result) => result.status).sort()).toEqual(["conflict", "selected"]);

      const winner = attempts.find((result) => result.status === "selected");
      if (winner?.status !== "selected") throw new Error("one CAS must win");
      const loserRelease = winner.selection.currentReleaseId === first.releaseId ? second : first;
      const advanced = ledger.compareAndSwapLastGreen({
        provider: "codex",
        releaseId: loserRelease.releaseId,
        expectedRevision: 1,
        changedAt: "2026-10-19T01:01:00.000Z",
      });
      expect(advanced.status).toBe("selected");

      const pinned = ledger.pinBack({
        provider: "codex",
        releaseId: winner.selection.currentReleaseId ?? "",
        expectedRevision: 2,
        changedAt: "2026-10-19T01:02:00.000Z",
        reason: "restore the earlier green release",
      });
      expect(pinned.status).toBe("selected");
      expect(ledger.resolveCurrent("codex")?.releaseId).toBe(winner.selection.currentReleaseId);
      expect(ledger.getSelection("codex")).toMatchObject({ revision: 3, action: "pinback" });
      expect(ledger.listSelectionEvents("codex").map(({ action }) => action)).toEqual([
        "green",
        "green",
        "pinback",
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("keeps the selected artifact and audit history across a database reopen", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "harness-release-ledger-"));
    const path = NodePath.join(directory, "ledger.sqlite");
    try {
      const beforeRestart = createDatabase(path);
      const release = artifact("claude-code", "claude-2.1.302");
      const firstLedger = createHarnessReleaseLedger(beforeRestart.store);
      firstLedger.registerArtifact(release);
      recordGreenProofs(firstLedger, release);
      expect(
        firstLedger.compareAndSwapLastGreen({
          provider: "claude-code",
          releaseId: release.releaseId,
          expectedRevision: 0,
          changedAt: "2026-10-19T02:00:00.000Z",
        }).status,
      ).toBe("selected");
      beforeRestart.database.close();

      const afterRestart = createDatabase(path);
      try {
        const restartedLedger = createHarnessReleaseLedger(afterRestart.store);
        expect(restartedLedger.resolveCurrent("claude-code")).toEqual(release);
        expect(restartedLedger.getSelection("claude-code")).toMatchObject({
          revision: 1,
          currentReleaseId: release.releaseId,
          lastGreenReleaseId: release.releaseId,
        });
        expect(restartedLedger.listSelectionEvents("claude-code")).toHaveLength(1);
      } finally {
        afterRestart.database.close();
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects mismatched proof identity and keeps an unmeasured peak heap pending", () => {
    const fixture = createDatabase();
    try {
      const ledger = createHarnessReleaseLedger(fixture.store);
      const release = artifact("agent-sdk", "sdk-1");
      ledger.registerArtifact(release);
      expect(() =>
        ledger.recordProof({
          ...proof(release, "local-workerd", "mismatched"),
          sourceIdentity: "source-from-another-release",
        }),
      ).toThrow("IDENTITY_MISMATCH");
      expect(ledger.listProofs("agent-sdk", release.releaseId)).toHaveLength(0);

      ledger.recordProof(
        proof(release, "local-workerd", "local-unmeasured", {
          metrics: metrics({
            state: "unmeasured",
            reason: "facet peak retained heap is not exposed",
          }),
        }),
      );
      expect(ledger.getEligibility("agent-sdk", release.releaseId)).toMatchObject({
        status: "pending",
        reasons: ["metrics-unmeasured", "missing-deployed-proof"],
      });
      ledger.recordProof(proof(release, "deployed-do", "deployed-measured"));

      expect(ledger.getEligibility("agent-sdk", release.releaseId)).toMatchObject({
        status: "pending",
        reasons: ["metrics-unmeasured"],
      });
      expect(
        ledger.compareAndSwapLastGreen({
          provider: "agent-sdk",
          releaseId: release.releaseId,
          expectedRevision: 0,
          changedAt: "2026-10-19T03:00:00.000Z",
        }),
      ).toMatchObject({ status: "not-green", selection: { revision: 0, currentReleaseId: null } });
      expect(ledger.resolveCurrent("agent-sdk")).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  it("does not advance current or last green when a required deployed check is rejected", () => {
    const fixture = createDatabase();
    try {
      const ledger = createHarnessReleaseLedger(fixture.store);
      const current = artifact("codex", "known-green");
      const candidate = artifact("codex", "candidate-red");
      ledger.registerArtifact(current);
      ledger.registerArtifact(candidate);
      recordGreenProofs(ledger, current);
      recordGreenProofs(ledger, candidate);
      expect(
        ledger.compareAndSwapLastGreen({
          provider: "codex",
          releaseId: current.releaseId,
          expectedRevision: 0,
          changedAt: "2026-10-19T04:00:00.000Z",
        }).status,
      ).toBe("selected");

      ledger.recordProof(
        proof(candidate, "deployed-do", "candidate-rejected", {
          checks: checks({ interrupt: "rejected" }),
        }),
      );
      expect(
        ledger.compareAndSwapLastGreen({
          provider: "codex",
          releaseId: candidate.releaseId,
          expectedRevision: 1,
          changedAt: "2026-10-19T04:01:00.000Z",
        }),
      ).toMatchObject({ status: "not-green", eligibility: { status: "rejected" } });
      expect(ledger.getSelection("codex")).toMatchObject({
        revision: 1,
        currentReleaseId: current.releaseId,
        lastGreenReleaseId: current.releaseId,
      });
      expect(ledger.listSelectionEvents("codex")).toHaveLength(1);
    } finally {
      fixture.database.close();
    }
  });

  it("requires current green evidence for pinback across all providers", () => {
    const supersedingProofs = [
      {
        id: "rejected",
        status: "rejected",
        options: { checks: checks({ interrupt: "rejected" }) },
      },
      {
        id: "pending",
        status: "pending",
        options: { checks: checks({ boot: "pending" }) },
      },
      {
        id: "unmeasured",
        status: "pending",
        options: {
          metrics: metrics({ state: "unmeasured", reason: "heap data is unavailable" }),
        },
      },
    ] as const;

    for (const provider of HARNESS_PROVIDERS) {
      for (const superseding of supersedingProofs) {
        const fixture = createDatabase();
        try {
          const ledger = createHarnessReleaseLedger(fixture.store);
          const earlier = artifact(provider, `${provider}-${superseding.id}-earlier`);
          const current = artifact(provider, `${provider}-${superseding.id}-current`);
          ledger.registerArtifact(earlier);
          ledger.registerArtifact(current);
          recordGreenProofs(ledger, earlier);
          recordGreenProofs(ledger, current);

          expect(
            ledger.compareAndSwapLastGreen({
              provider,
              releaseId: earlier.releaseId,
              expectedRevision: 0,
              changedAt: "2026-10-19T05:00:00.000Z",
            }).status,
          ).toBe("selected");
          expect(
            ledger.compareAndSwapLastGreen({
              provider,
              releaseId: current.releaseId,
              expectedRevision: 1,
              changedAt: "2026-10-19T05:01:00.000Z",
            }).status,
          ).toBe("selected");

          ledger.recordProof(
            proof(
              earlier,
              "deployed-do",
              `${provider}-${superseding.id}-superseding`,
              superseding.options,
            ),
          );
          expect(ledger.getEligibility(provider, earlier.releaseId).status).toBe(
            superseding.status,
          );
          expect(
            ledger.pinBack({
              provider,
              releaseId: earlier.releaseId,
              expectedRevision: 2,
              changedAt: "2026-10-19T05:02:00.000Z",
              reason: "restore an earlier release",
            }),
          ).toMatchObject({ status: "not-green", eligibility: { status: superseding.status } });
          expect(ledger.resolveCurrent(provider)?.releaseId).toBe(current.releaseId);
          expect(ledger.getSelection(provider)).toMatchObject({
            revision: 2,
            currentReleaseId: current.releaseId,
            lastGreenReleaseId: current.releaseId,
          });
          expect(ledger.listSelectionEvents(provider)).toHaveLength(2);

          ledger.recordProof(
            proof(earlier, "deployed-do", `${provider}-${superseding.id}-restored-green`),
          );
          expect(ledger.getEligibility(provider, earlier.releaseId).status).toBe("green");
          expect(
            ledger.pinBack({
              provider,
              releaseId: earlier.releaseId,
              expectedRevision: 2,
              changedAt: "2026-10-19T05:03:00.000Z",
              reason: "restore an earlier release after clean evidence",
            }).status,
          ).toBe("selected");
          expect(ledger.resolveCurrent(provider)?.releaseId).toBe(earlier.releaseId);
          expect(ledger.getSelection(provider)).toMatchObject({
            revision: 3,
            currentReleaseId: earlier.releaseId,
            lastGreenReleaseId: current.releaseId,
            action: "pinback",
          });
          expect(ledger.listSelectionEvents(provider).at(-1)).toMatchObject({
            action: "pinback",
            fromReleaseId: current.releaseId,
            toReleaseId: earlier.releaseId,
            reason: "restore an earlier release after clean evidence",
          });
        } finally {
          fixture.database.close();
        }
      }
    }
  });

  it("keeps provider source identities in separate release records", () => {
    const fixture = createDatabase();
    try {
      const ledger = createHarnessReleaseLedger(fixture.store);
      const releases = HARNESS_PROVIDERS.map((provider) => artifact(provider, "same-label"));
      for (const release of releases) ledger.registerArtifact(release);
      expect(
        releases.map(
          (release) => ledger.getArtifact(release.provider, release.releaseId)?.sourceIdentity,
        ),
      ).toEqual(releases.map((release) => release.sourceIdentity));
    } finally {
      fixture.database.close();
    }
  });
});
