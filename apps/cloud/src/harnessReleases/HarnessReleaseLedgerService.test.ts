import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubActions from "../github/GitHubActions.ts";
import {
  HarnessReleaseLedgerService,
  harnessReleaseLedgerLayer,
} from "./HarnessReleaseLedgerService.ts";
import type { HarnessReleaseSqliteDatabase } from "./HarnessReleaseSqliteStore.ts";

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
  return { database, storage };
};

const githubLayer = (
  workflowArtifact: GitHubActions.GitHubActions["Service"]["workflowArtifact"],
) =>
  Layer.succeed(
    GitHubActions.GitHubActions,
    GitHubActions.GitHubActions.of({
      workflowArtifact,
    } as GitHubActions.GitHubActions["Service"]),
  );

describe("project harness ledger service", () => {
  it.effect("scopes selection to the trusted project argument", () =>
    Effect.gen(function* () {
      const f = fixture();
      try {
        const service = harnessReleaseLedgerLayer(f.storage).pipe(
          Layer.provide(githubLayer(() => Effect.succeed(null))),
        );
        const ledger = yield* Effect.gen(function* () {
          return yield* HarnessReleaseLedgerService;
        }).pipe(Effect.provide(service));
        expect(yield* Effect.provide(ledger.selection("alpha", "codex"), service)).toMatchObject({
          revision: 0,
          currentReleaseId: null,
          lastGreenReleaseId: null,
        });
        expect(yield* Effect.provide(ledger.selection("beta", "codex"), service)).toMatchObject({
          revision: 0,
          currentReleaseId: null,
          lastGreenReleaseId: null,
        });
        expect(
          yield* Effect.provide(
            ledger.promote("alpha", {
              provider: "codex",
              releaseId: "candidate",
              expectedRevision: 0,
              changedAt: "2026-10-19T00:00:00.000Z",
            }),
            service,
          ),
        ).toMatchObject({
          status: "pending",
          runtimeArtifactVerified: false,
        });
        expect(yield* Effect.provide(ledger.selection("alpha", "codex"), service)).toMatchObject({
          revision: 0,
          currentReleaseId: null,
          lastGreenReleaseId: null,
        });
      } finally {
        f.database.close();
      }
    }),
  );

  it.effect(
    "verifies the exact workflow result bytes and keeps it pending without a deployable payload",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        try {
          const sourceHead = "a".repeat(40);
          const runKey = "harness-release:codex:1.2.3";
          const checks = [
            "boot",
            "text",
            "readEdit",
            "bash",
            "grep",
            "resume",
            "mcp",
            "interrupt",
            "publicHarness",
          ];
          const result = {
            schemaVersion: 1,
            provider: "codex",
            version: "1.2.3",
            runKey,
            selection: "current",
            status: "green",
            source: { commit: sourceHead },
            unchangedSource: "passed",
            environments: Object.fromEntries(
              ["local-workerd", "deployed"].map((environment) => [
                environment,
                {
                  checks: checks.map((name) => ({ name, status: "passed" })),
                  metrics: {
                    moduleBytes: { state: "measured", value: 1 },
                    bootTimeMs: { state: "measured", value: 1 },
                    peakHeapBytes: { state: "measured", value: 1 },
                  },
                },
              ]),
            ),
          };
          const artifact = {
            run: {
              runId: "12345",
              url: "https://github.com/JustYannicc/signalbox/actions/runs/12345",
              workflowFile: ".github/workflows/harness-release-proof.yml",
              headSha: sourceHead,
              displayTitle: runKey,
              status: "completed",
              conclusion: "success",
            },
            artifact: {
              id: "987",
              name: "harness-release-codex-1.2.3-12345-1",
              digest: `sha256:${"b".repeat(64)}`,
              entryPath: "result.json",
              sha256: "c".repeat(64),
              bytes: 100,
            },
            text: JSON.stringify(result),
          };
          const service = harnessReleaseLedgerLayer(f.storage).pipe(
            Layer.provide(githubLayer(() => Effect.succeed(artifact))),
          );
          const call = yield* Effect.gen(function* () {
            const ledger = yield* HarnessReleaseLedgerService;
            return ledger.record;
          }).pipe(Effect.provide(service));
          const record = yield* Effect.provide(
            call("alpha", {
              provider: "codex",
              version: "1.2.3",
              runKey,
              headSha: sourceHead,
              workflowFile: ".github/workflows/harness-release-proof.yml",
              workflowRunId: "12345",
              artifactName: "harness-release-codex-1.2.3-12345-1",
              entryPath: "result.json",
              selection: "current",
            }),
            service,
          );
          expect(record).toMatchObject({
            status: "pending",
            proofStatus: "green",
            proofArtifactVerified: true,
            runtimeArtifactVerified: false,
            result: { status: "green" },
          });
          const incompleteService = harnessReleaseLedgerLayer(f.storage).pipe(
            Layer.provide(
              githubLayer(() =>
                Effect.succeed({
                  ...artifact,
                  text: JSON.stringify({ ...result, environments: {} }),
                }),
              ),
            ),
          );
          const incompleteCall = yield* Effect.gen(function* () {
            const ledger = yield* HarnessReleaseLedgerService;
            return ledger.record;
          }).pipe(Effect.provide(incompleteService));
          const incomplete = yield* Effect.provide(
            incompleteCall("alpha", {
              provider: "codex",
              version: "1.2.3",
              runKey,
              headSha: sourceHead,
              workflowFile: ".github/workflows/harness-release-proof.yml",
              workflowRunId: "12345",
              artifactName: "harness-release-codex-1.2.3-12345-1",
              entryPath: "result.json",
              selection: "current",
            }),
            incompleteService,
          );
          expect(incomplete).toMatchObject({
            status: "pending",
            proofStatus: "pending",
            proofArtifactVerified: true,
          });
          const wrongHead = yield* Effect.provide(
            call("alpha", {
              provider: "codex",
              version: "1.2.3",
              runKey,
              headSha: "d".repeat(40),
              workflowFile: ".github/workflows/harness-release-proof.yml",
              workflowRunId: "12345",
              artifactName: "harness-release-codex-1.2.3-12345-1",
              entryPath: "result.json",
              selection: "current",
            }),
            service,
          );
          expect(wrongHead).toMatchObject({
            status: "pending",
            proofArtifactVerified: false,
          });
        } finally {
          f.database.close();
        }
      }),
  );
});
