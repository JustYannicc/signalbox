import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as LearnerJev from "./LearnerJev.ts";
import * as LearnerService from "./LearnerService.ts";
import * as LearnerStore from "./LearnerStore.ts";

describe("learner changes while a judgment is running", () => {
  it.effect("rejects a stale authorized write after its tree was revoked", () =>
    Effect.gen(function* () {
      const learner = yield* LearnerService.LearnerService;
      yield* learner.revokeTree("company-tree");
      const result = yield* Effect.result(
        learner.logEvent({
          scope: "company",
          event: {
            eventId: "late-observation",
            treeId: "company-tree",
            source: "thread",
            kind: "observation",
            content: "A delivery authorized before membership removal.",
          },
        }),
      );
      expect(result._tag).toBe("Failure");
      const rows = yield* (yield* SqlClient.SqlClient)<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_events`;
      expect(rows[0]?.count).toBe(0);
    }).pipe(
      Effect.provide(
        LearnerService.layer.pipe(
          Layer.provide(LearnerJev.layerNone),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  );

  it.effect("does not recreate a revoked tree's evidence when an in-flight judgment finishes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const judge = LearnerJev.LearnerJev.of({
        summarySafe: () => Effect.succeed(false),
        classifyPair: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return Option.some("confirmed" as const);
          }),
        matchDraft: () => Effect.succeedNone,
        relevance: () => Effect.succeed([]),
        outcome: () => Effect.succeedNone,
        coverage: () => Effect.succeedNone,
      });
      yield* Effect.gen(function* () {
        const learner = yield* LearnerService.LearnerService;
        const sql = yield* SqlClient.SqlClient;
        yield* learner.logEvent({
          scope: "company",
          event: {
            eventId: "draft",
            treeId: "company-tree",
            source: "asks",
            kind: "draft",
            objectId: "question",
            input: "May we deploy?",
            content: "Wait for checks.",
          },
        });
        const action = yield* Effect.forkChild(
          learner.logEvent({
            scope: "company",
            event: {
              eventId: "answer",
              treeId: "company-tree",
              source: "asks",
              kind: "human_action",
              objectId: "question",
              content: "Wait for checks.",
            },
          }),
        );
        yield* Deferred.await(started);
        yield* sql.withTransaction(LearnerStore.deleteTreeContributions(sql, "company-tree"));
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(action)).paired).toBe(false);
        const precedents = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_precedents`;
        const lenses = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM sbx_level_learner_668_lenses`;
        expect(precedents[0]?.count).toBe(0);
        expect(lenses[0]?.count).toBe(0);
      }).pipe(
        Effect.provide(
          LearnerService.layer.pipe(
            Layer.provideMerge(Layer.succeed(LearnerJev.LearnerJev, judge)),
            Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
          ),
        ),
      );
    }),
  );
});
