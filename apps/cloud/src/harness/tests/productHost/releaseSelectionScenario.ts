// @effect-diagnostics nodeBuiltinImport:off - The native personality runs inside an isolated test realm.
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import { createClaudeToolObservation } from "../../ClaudeToolObservation.ts";
import { createProductClaudeHarnessSessionHost } from "../../ProductClaudeHarnessSessionHost.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { makeContinuationHostInputs } from "./continuationHostInputs.ts";
import { claudeReleaseVariantsFixture } from "./releaseVariants.fixture.ts";

export type ReleaseSelectionScenario = "baseline" | "sdk" | "settings";

export const run = (scenario: ReleaseSelectionScenario) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (db) =>
          Effect.sync(() => db.dispose()),
        );
        const input = yield* makeContinuationHostInputs(database.open(), false);
        const fixtures = yield* Effect.promise(claudeReleaseVariantsFixture);
        const expected =
          scenario === "baseline" ? fixtures.baselineArtifact : fixtures.hooksArtifact;
        const host = yield* createProductClaudeHarnessSessionHost({
          ...input.hostOptions,
          release: fixtures.release,
          releaseVariants: fixtures.releaseVariants,
          ...(scenario === "settings"
            ? { settingsHooks: [{ id: "before-command", event: "pre-tool-use" as const }] }
            : {}),
          native: {
            ...input.hostOptions.native,
            ...(scenario === "sdk"
              ? { toolObservation: createClaudeToolObservation(() => undefined) }
              : {}),
          },
        });
        yield* host.seed("assets");
        yield* host.seed("programs");
        yield* host.open({ session: input.sessionInput, bootAttemptId: `selection-${scenario}` });
        NodeAssert.deepEqual(host.loadedPreparedRelease().artifact, expected);
        const selectedReads =
          scenario === "baseline" ? fixtures.baseline.reads : fixtures.hooks.reads;
        const unusedReads =
          scenario === "baseline" ? fixtures.hooks.reads : fixtures.baseline.reads;
        NodeAssert.ok(selectedReads.includes("manifest.json"));
        NodeAssert.equal(unusedReads.length, 0);
        yield* host.dispose;
      }),
    ),
  );
