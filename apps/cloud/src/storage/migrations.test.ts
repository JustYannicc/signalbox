import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as Migrations from "./migrations.ts";

/** A migration that creates `table`, so running one twice fails. */
const creates = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE ${sql(table)} (id INTEGER PRIMARY KEY)`;
  });

const recorded = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id, name`;
  return rows.map((row) => `${row.migration_id}_${row.name}`);
});

const tables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'effect_sql%' ORDER BY name`;
  return rows.map((row) => row.name);
});

// Each test is one object's database across several starts.
const layer = NodeSqliteClient.layer({ filename: ":memory:" });

describe("migrations", () => {
  it.effect("an object that ran an abandoned branch's 0009 still gets main's", () =>
    Effect.gen(function* () {
      const base = { "0001_init": creates("init") };
      yield* Migrations.run(Migrator.fromRecord({ ...base, "0009_tried": creates("tried") }));
      const ran = yield* Migrations.run(
        Migrator.fromRecord({ ...base, "0009_shipped": creates("shipped") }),
      );

      expect(ran).toEqual([[9, "shipped"]]);
      expect(yield* recorded).toEqual(["1_init", "9_shipped", "9_tried"]);
      expect(yield* tables).toEqual(["init", "shipped", "tried"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an object the old runner migrated upgrades and re-runs nothing", () =>
    Effect.gen(function* () {
      const old = { "0001_init": creates("init"), "0002_more": creates("more") };
      yield* Migrator.make({})({ loader: Migrator.fromRecord(old) });

      const ran = yield* Migrations.run(
        Migrator.fromRecord({ ...old, "0003_next": creates("next") }),
      );
      expect(ran).toEqual([[3, "next"]]);
      expect(yield* recorded).toEqual(["1_init", "2_more", "3_next"]);
      // A second start, and Migrator itself on the rebuilt table, find nothing to do.
      expect(yield* Migrations.run(Migrator.fromRecord(old))).toEqual([]);
      expect(yield* Migrator.make({})({ loader: Migrator.fromRecord(old) })).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a lower id added after a higher one ran still runs", () =>
    Effect.gen(function* () {
      yield* Migrations.run(
        Migrator.fromRecord({ "0001_init": creates("init"), "0003_later": creates("later") }),
      );
      const ran = yield* Migrations.run(
        Migrator.fromRecord({
          "0001_init": creates("init"),
          "0002_merged_late": creates("merged_late"),
          "0003_later": creates("later"),
        }),
      );

      expect(ran).toEqual([[2, "merged_late"]]);
      expect(yield* recorded).toEqual(["1_init", "2_merged_late", "3_later"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a failing migration stops the run and is retried on the next start", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const broken = Effect.gen(function* () {
        yield* creates("half");
        yield* sql`INSERT INTO missing VALUES (1)`;
      });
      const first = yield* Effect.exit(
        Migrations.run(
          Migrator.fromRecord({
            "0001_init": creates("init"),
            "0002_broken": broken,
            "0003_after": creates("after"),
          }),
        ),
      );

      expect(Exit.isFailure(first)).toBe(true);
      // Its transaction rolled back, record and half-made table alike; nothing after it ran.
      expect(yield* recorded).toEqual(["1_init"]);
      expect(yield* tables).toEqual(["init"]);

      const ran = yield* Migrations.run(
        Migrator.fromRecord({
          "0001_init": creates("init"),
          "0002_broken": creates("half"),
          "0003_after": creates("after"),
        }),
      );
      expect(ran).toEqual([
        [2, "broken"],
        [3, "after"],
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
