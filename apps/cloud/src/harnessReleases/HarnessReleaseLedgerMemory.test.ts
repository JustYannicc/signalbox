import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as CloudCompiler from "../automations/cloudCompiler.ts";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { makeHarnessReleaseLedgerTestDatabase } from "./testing.ts";

const projectId = Environment.SCRATCH_PROJECT_ID;
const source = `export const meta = { name: "Read release selection" } as const;
export default workflow(async (w) => await w.call(
  "Read the selected release",
  "signalbox.harness_release_ledger",
  { action: "selection", provider: "codex" }
));`;

const compiled = compileForCloud(source);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));

describe("memory cloud harness release ledger", () => {
  it("creates independent in-memory databases", () => {
    const first = makeHarnessReleaseLedgerTestDatabase();
    const second = makeHarnessReleaseLedgerTestDatabase();
    try {
      first.storage.sql.exec("CREATE TABLE isolation_check (value TEXT NOT NULL)");
      second.storage.sql.exec("CREATE TABLE isolation_check (value TEXT NOT NULL)");
      first.storage.sql.exec("INSERT INTO isolation_check VALUES (?)", "first");
      second.storage.sql.exec("INSERT INTO isolation_check VALUES (?)", "second");

      expect(Array.from(first.storage.sql.exec("SELECT value FROM isolation_check"))).toEqual([
        { value: "first" },
      ]);
      expect(Array.from(second.storage.sql.exec("SELECT value FROM isolation_check"))).toEqual([
        { value: "second" },
      ]);
    } finally {
      first.database.close();
      second.database.close();
    }
  });

  it.effect("runs the real ledger builtin in each user's runtime", () => {
    const cloud = makeMemoryCloud();
    return Effect.gen(function* () {
      const start = (userId: string) =>
        cloud.inUser(
          userId,
          Effect.gen(function* () {
            const compiler = yield* CloudCompiler.CloudCompiler;
            const engine = yield* WorkflowEngine.WorkflowEngine;
            const accepted = yield* CloudCompiler.acceptCompiled(compiled.compiled);
            const saved = yield* compiler.withStaged(
              source,
              accepted,
              engine.save(
                {
                  source,
                  projectId,
                  defaults: {
                    modelSelection: scriptedModelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  },
                },
                undefined,
                "signalbox",
              ),
            );
            if (!saved.ok) return yield* Effect.die(saved.diagnostics);
            return yield* engine.startRun({
              automationId: saved.automation.id,
              projectId,
              trigger: "manual",
            });
          }),
        );

      const firstUser = "ledger-user-one";
      const secondUser = "ledger-user-two";
      yield* cloud.userDirectory.forUser(firstUser).recordSignIn({
        id: firstUser,
        email: "one@example.test",
      });
      yield* cloud.userDirectory.forUser(secondUser).recordSignIn({
        id: secondUser,
        email: "two@example.test",
      });

      const firstRun = yield* start(firstUser);
      const secondRun = yield* start(secondUser);
      yield* cloud.workflows.idle;

      const first = yield* cloud.inUser(
        firstUser,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(firstRun.id)),
      );
      const second = yield* cloud.inUser(
        secondUser,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(secondRun.id)),
      );
      const emptySelection = {
        provider: "codex",
        revision: 0,
        currentReleaseId: null,
        lastGreenReleaseId: null,
        action: null,
        changedAt: null,
      };

      expect([first.run.status, first.output]).toEqual(["succeeded", emptySelection]);
      expect([second.run.status, second.output]).toEqual(["succeeded", emptySelection]);
    }).pipe(Effect.ensuring(cloud.dispose));
  });
});
